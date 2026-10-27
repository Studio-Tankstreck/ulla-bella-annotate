package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ullabella-annotate/internal/proto"
)

// HermesExecutor sends the Job to the local Hermes gateway via its durable
// /v1/runs API (submit a run, poll it to a terminal result, read the final
// output) and maps the structured outcome Hermes returns into an adapter
// Outcome. It also performs a deterministic postcondition check on the edited
// file as defense-in-depth. When a RunStore is attached, the jobId→run_id
// mapping is persisted so a restart can resume (never re-run) the work.
type HermesExecutor struct {
	BaseURL string
	APIKey  string
	Model   string
	Client  *http.Client

	// PollClient is used for run-status polling. A short timeout lets a hung
	// status GET fail fast and retry; nil falls back to Client.
	PollClient *http.Client
	// PollInterval is the delay between run-status polls (0 → 2s default).
	PollInterval time.Duration
	// AdmissionRetryBackoff is the initial delay between admission retries
	// after an uncertain (network/timeout/5xx) failure (0 → 500ms default).
	// Retries are bounded and reuse the SAME Idempotency-Key, so they recover
	// the original run rather than executing twice.
	AdmissionRetryBackoff time.Duration
	// ActivityHeartbeat is the minimum delay between repeated activity
	// emissions for a single job (0 → 5s default). Used to keep the Relay's
	// activity snapshot fresh even when the agent is quiet.
	ActivityHeartbeat time.Duration
	// OnActivity, when non-nil, receives each observed activity snapshot
	// (keyed by jobId) as a durable run progresses. The adapter wires this to
	// a non-terminal "working" Result write to the Relay.
	OnActivity func(jobID string, a proto.Activity)
	// Store, when non-nil, is the durable job→run mapping for restart recovery.
	Store *RunStore
}

// NewHermesExecutor builds an executor from the process environment. The API key
// is read from HERMES_API_KEY and never logged or persisted to disk.
func NewHermesExecutor() *HermesExecutor {
	return &HermesExecutor{
		BaseURL:      strings.TrimRight(proto.EnvOr("HERMES_BASE_URL", "http://127.0.0.1:8642"), "/"),
		APIKey:       os.Getenv("HERMES_API_KEY"),
		Model:        proto.EnvOr("HERMES_MODEL", "hermes-agent"),
		Client:       &http.Client{Timeout: 5 * time.Minute},
		PollClient:   &http.Client{Timeout: 30 * time.Second},
		PollInterval: 2 * time.Second,
	}
}

// newHermesExecutorConfig builds the executor from the config's Hermes section.
// The API key is read from the referenced env var and never logged or persisted.
func newHermesExecutorConfig(hc HermesConfig) *HermesExecutor {
	return &HermesExecutor{
		BaseURL:      hermesOrigin(hc.BaseURL),
		APIKey:       os.Getenv(hc.APIKeyEnv),
		Model:        hc.Model,
		Client:       &http.Client{Timeout: 5 * time.Minute},
		PollClient:   &http.Client{Timeout: 30 * time.Second},
		PollInterval: 2 * time.Second,
	}
}

// hermesOrigin normalizes hermes.base_url to the gateway origin (no /v1),
// accepting both "http://host:8642" and "http://host:8642/v1".
func hermesOrigin(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		base = strings.TrimSuffix(base, "/v1")
	}
	return base
}

func (h *HermesExecutor) Execute(ctx SiteContext) Outcome {
	if h.APIKey == "" {
		return errorOutcome("hermes_unavailable", "Hermes API key is not configured")
	}
	if ctx.Config.EditingMode == editingModeYoothemeMCP {
		if ctx.Config.MCP == nil || os.Getenv(ctx.Config.MCP.TokenEnvVar) == "" {
			return errorOutcome("mcp_unconfigured", "YOOtheme MCP token is not configured (agent-side)")
		}
	}
	if ctx.Config.EditingMode == editingModeEmdash {
		if ctx.Config.Emdash == nil || os.Getenv(ctx.Config.Emdash.TokenEnvVar) == "" {
			return errorOutcome("emdash_unconfigured", "EmDash token is not configured (agent-side)")
		}
	}

	content, err := h.run(ctx)
	if err != nil {
		return errorOutcome("hermes_unavailable", err.Error())
	}
	return h.finalize(ctx, content)
}

// Resume polls an already-admitted run and finalizes its result without
// re-submitting. Used by restart/reconnect recovery for a persisted run_id.
func (h *HermesExecutor) Resume(ctx SiteContext, runID string) Outcome {
	content, err := h.pollRunEmit(ctx.Job.JobID, runID)
	if err != nil {
		return errorOutcome("hermes_unavailable", err.Error())
	}
	return h.finalize(ctx, content)
}

// run admits a durable run for the task, persists the run_id mapping, and polls
// to the final response text. Admission is two-phase: the record is moved to
// "admission_in_flight" BEFORE the submit, so a crash between admission and
// run_id persistence is recoverable without guessing whether a run was created.
func (h *HermesExecutor) run(ctx SiteContext) (string, error) {
	prompt := h.buildTask(ctx)
	if h.Store != nil {
		if err := h.Store.MarkAdmissionInFlight(ctx.Job.JobID); err != nil {
			return "", fmt.Errorf("mark admission in flight: %w", err)
		}
	}
	runID, err := h.submitRun(prompt, idempotencyKey(ctx.Job.JobID))
	if err != nil {
		return "", err
	}
	h.persistRunID(ctx, runID)
	// The run is admitted: report the first observed activity ("starting")
	// before polling, so the browser has a signal even before Hermes emits its
	// first tool/interim event.
	h.emitActivity(ctx.Job.JobID, activityStarting, time.Now())
	return h.pollRunEmit(ctx.Job.JobID, runID)
}

// persistRunID records the jobId→run_id mapping so a restart can resume the run.
// Best-effort: the Idempotency-Key still protects a lost run_id (re-admission
// with the same key returns the same run), so a persistence failure is logged,
// not fatal.
func (h *HermesExecutor) persistRunID(ctx SiteContext, runID string) {
	if h.Store == nil {
		return
	}
	if err := h.Store.SetRunID(ctx.Job.JobID, runID); err != nil {
		log.Printf("adapter: persist run_id for job %s: %v", ctx.Job.JobID, err)
	}
}

// finalize parses the run output into an Outcome and applies the deterministic
// postcondition. It is shared by Execute (fresh run) and Resume (recovered run)
// so the two paths can never drift on result parsing or verification.
func (h *HermesExecutor) finalize(ctx SiteContext, content string) Outcome {
	// The deterministic postcondition runs here, in the adapter, after Hermes
	// has settled — surface it as its own activity phase.
	h.emitActivity(ctx.Job.JobID, activityVerifying, time.Now())
	if len(ctx.Targets) > 1 {
		results, err := parseHermesBatchOutcome(content)
		if err != nil {
			return errorOutcome("hermes_outcome_unparseable", err.Error())
		}
		return h.assembleBatchOutcome(ctx, results)
	}
	outcome := parseHermesOutcome(content)
	if outcome.Status == proto.StatusDone {
		if code, msg, ok := postcondition(ctx); !ok {
			return errorOutcome(code, msg)
		}
	}
	return outcome
}

// assembleBatchOutcome applies the deterministic postcondition to each "done"
// annotation so Hermes's self-report is never the sole proof of success, then
// returns a job-level Outcome. Job status is "done" because the round was
// processed even when some annotations failed; per-annotation outcomes live in
// AnnotationResults and are normalized (missing/duplicate/unknown) in handleJob.
func (h *HermesExecutor) assembleBatchOutcome(ctx SiteContext, results []proto.AnnotationResult) Outcome {
	for i := range results {
		if results[i].Status == proto.StatusDone {
			if code, msg, ok := postconditionFor(ctx, results[i].AnnotationID); !ok {
				results[i] = proto.AnnotationResult{
					AnnotationID: results[i].AnnotationID,
					Status:       proto.StatusError,
					Error:        &proto.Error{Code: code, Message: msg},
				}
			}
		}
	}
	return Outcome{
		Status:            proto.StatusDone,
		AnnotationResults: results,
	}
}

// buildTask constructs the concise execution task handed to Hermes (Part 7 of the
// task contract): site identity, allowed workspace, target page, the target
// element, the requested change, scope restriction, and a verification + a
// machine-readable-outcome requirement.
func (h *HermesExecutor) buildTask(ctx SiteContext) string {
	switch ctx.Config.EditingMode {
	case editingModeYoothemeMCP:
		return h.buildMCPTask(ctx)
	case editingModeEmdash:
		return h.buildEmdashTask(ctx)
	default:
		return h.buildFilesystemTask(ctx)
	}
}

// writeSessionContext writes the user's overall session description, when the
// job carries one, as shared context for every task in the prompt. It is
// deliberately written ONCE, before the annotations: it must never become an
// extra task and must never be repeated per annotation.
func writeSessionContext(b *strings.Builder, jb proto.Job) {
	if jb.Context == nil {
		return
	}
	desc := strings.TrimSpace(jb.Context.Session)
	if desc == "" {
		return
	}
	b.WriteString("Session description (what the user is doing on this page overall — shared context for every annotation below; it is not a task of its own and must not be repeated per annotation):\n")
	b.WriteString(desc)
	b.WriteString("\n\n")
}

// writeAnnotationHeading separates the shared session context from the
// individual annotations, each of which keeps its stable annotationId.
func writeAnnotationHeading(b *strings.Builder, count int) {
	if count <= 1 {
		return
	}
	b.WriteString("Annotations (one task each, identified by their stable annotationId):\n\n")
}

// annotationHeading renders the per-annotation line: numbered for a batch,
// a single labelled block for one annotation. The annotationId is always
// shown — it is what the per-annotation result is keyed by.
func annotationHeading(b *strings.Builder, index, total int, annotationID string) {
	if total > 1 {
		fmt.Fprintf(b, "Task %d (annotationId: %s)\n", index+1, annotationID)
		return
	}
	fmt.Fprintf(b, "Annotation (annotationId: %s)\n", annotationID)
}

// buildFilesystemTask constructs the concise execution task for the filesystem
// slice (Task 07): site identity, allowed workspace, target page, the target
// element, the requested change, scope restriction, and a verification + a
// machine-readable-outcome requirement.
func (h *HermesExecutor) buildFilesystemTask(ctx SiteContext) string {
	var b strings.Builder
	b.WriteString("You are performing one Ulla-Bella website-editing task.\n\n")
	b.WriteString("Allowed site:\n" + ctx.Config.Origin + "\n\n")
	b.WriteString("Allowed workspace (do not modify anything outside it):\n" + ctx.Config.Workspace + "\n\n")

	writeSessionContext(&b, ctx.Job)
	writeAnnotationHeading(&b, len(ctx.Targets))

	for i, t := range ctx.Targets {
		ann := t.Annotation
		annotationHeading(&b, i, len(ctx.Targets), ann.AnnotationID)
		b.WriteString("Target page: " + ann.Target.URL + "\n")
		b.WriteString("Workspace file to edit: " + t.FilePath + "\n")
		if ann.Target.ElementType != "" {
			b.WriteString("Element type: " + ann.Target.ElementType + "\n")
		}
		if ann.Target.VisibleText != "" {
			b.WriteString("Visible text: " + strconv.Quote(ann.Target.VisibleText) + "\n")
		}
		if ann.Target.Selector != "" {
			b.WriteString("Selector hint: " + ann.Target.Selector + "\n")
		}
		if s, ok := ann.Context["nearbyText"].(string); ok && s != "" {
			b.WriteString("Nearby context: " + s + "\n")
		}
		b.WriteString("Requested change: " + ann.Instruction + "\n\n")
	}

	b.WriteString("Perform the requested change using your available file tools. Edit only the workspace files listed above. Do not modify anything outside the configured workspace.\n\n")
	b.WriteString("After editing, read the file(s) back yourself and verify the requested change is actually present.\n\n")
	b.WriteString("If you cannot find the target element or text, or you cannot make the change, do not fabricate success — report an error.\n\n")
	writeResponseFormat(&b, len(ctx.Targets) > 1)
	return b.String()
}

// hermesOutcome is the structured machine-readable result Hermes is asked to
// return. This is the Hermes Adapter execution contract, not a browser protocol
// type — it is never serialized into a V1 Result directly.
type hermesOutcome struct {
	Status       string `json:"status"`
	Summary      string `json:"summary"`
	Verification *struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
	} `json:"verification"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// parseHermesOutcome extracts the JSON object from Hermes's final answer and maps
// it to an adapter Outcome. It tolerates code fences and surrounding prose.
func parseHermesOutcome(content string) Outcome {
	obj, err := extractJSONObject(content)
	if err != nil {
		return errorOutcome("hermes_outcome_unparseable", "Hermes did not return a structured outcome")
	}

	var ho hermesOutcome
	if err := json.Unmarshal([]byte(obj), &ho); err != nil {
		return errorOutcome("hermes_outcome_unparseable", "Hermes outcome is not valid JSON")
	}

	switch ho.Status {
	case "done":
		if ho.Verification == nil || ho.Verification.Status != "passed" {
			return errorOutcome("verification_failed", "Hermes reported done without passed verification")
		}
		summary := ho.Summary
		if summary == "" && ho.Verification.Summary != "" {
			summary = ho.Verification.Summary
		}
		return doneOutcome(summary)
	case "error":
		code, msg := "edit_failed", "Hermes reported an error"
		if ho.Error != nil {
			if ho.Error.Code != "" {
				code = ho.Error.Code
			}
			if ho.Error.Message != "" {
				msg = ho.Error.Message
			}
		}
		return errorOutcome(code, msg)
	default:
		return errorOutcome("hermes_outcome_unparseable", "Hermes returned an unknown status")
	}
}

// extractJSONObject pulls the outermost JSON object out of a Hermes answer,
// tolerating code fences and surrounding prose.
func extractJSONObject(content string) (string, error) {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start == -1 || end <= start {
		return "", fmt.Errorf("no JSON object found")
	}
	return content[start : end+1], nil
}

// writeResponseFormat appends the machine-readable-outcome contract. Single
// annotations keep the original job-level shape; a batch requires one result
// entry per annotationId.
func writeResponseFormat(b *strings.Builder, multi bool) {
	if !multi {
		b.WriteString("Respond with ONLY a JSON object (no markdown fences, no prose), in one of these shapes:\n")
		b.WriteString(`{"status":"done","summary":"...","verification":{"status":"passed","summary":"..."}}` + "\n")
		b.WriteString(`{"status":"error","error":{"code":"edit_failed","message":"..."}}` + "\n\n")
		b.WriteString("Only report status \"done\" if you yourself verified the change is present.\n")
		return
	}
	b.WriteString("Respond with ONLY a JSON object (no markdown fences, no prose) carrying a \"results\" array with EXACTLY one entry per annotation ID listed above:\n")
	b.WriteString(`{"results":[{"annotationId":"<id>","status":"done","summary":"...","verification":{"status":"passed","summary":"..."}},{"annotationId":"<id>","status":"error","error":{"code":"edit_failed","message":"..."}}]}` + "\n")
	b.WriteString("Only report status \"done\" for an annotation if you yourself verified that specific change is present. Do not fabricate success; report an error entry for anything you could not complete or verify.\n")
}

// hermesBatch is the structured multi-annotation outcome Hermes is asked to
// return. It is an adapter contract, not a browser protocol type.
type hermesBatch struct {
	Results []hermesBatchResult `json:"results"`
}

type hermesBatchResult struct {
	AnnotationID string `json:"annotationId"`
	Status       string `json:"status"`
	Summary      string `json:"summary"`
	Verification *struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
	} `json:"verification"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// parseHermesBatchOutcome extracts and validates the structured batch result.
// It returns an error only for a whole-response structural failure (not JSON /
// no results); per-entry problems are converted to error results so a missing
// or unclear entry can never silently become "done".
func parseHermesBatchOutcome(content string) ([]proto.AnnotationResult, error) {
	obj, err := extractJSONObject(content)
	if err != nil {
		return nil, fmt.Errorf("batch outcome is not valid JSON: %w", err)
	}
	var hb hermesBatch
	if err := json.Unmarshal([]byte(obj), &hb); err != nil {
		return nil, fmt.Errorf("batch outcome is not valid JSON: %w", err)
	}
	if len(hb.Results) == 0 {
		return nil, fmt.Errorf("batch outcome has no results")
	}
	out := make([]proto.AnnotationResult, 0, len(hb.Results))
	for _, r := range hb.Results {
		out = append(out, toAnnotationResult(r))
	}
	return out, nil
}

// toAnnotationResult maps one Hermes batch entry to an AnnotationResult. A
// missing annotationId yields an unmappable entry (dropped later); done without
// passed verification or an unknown status yields an error - never "done".
func toAnnotationResult(r hermesBatchResult) proto.AnnotationResult {
	id := r.AnnotationID
	if id == "" {
		return proto.AnnotationResult{Status: proto.StatusError}
	}
	switch r.Status {
	case "done":
		if r.Verification == nil || r.Verification.Status != "passed" {
			return proto.AnnotationResult{
				AnnotationID: id,
				Status:       proto.StatusError,
				Error:        &proto.Error{Code: "verification_failed", Message: "Hermes reported done without passed verification"},
			}
		}
		summary := r.Summary
		if summary == "" && r.Verification.Summary != "" {
			summary = r.Verification.Summary
		}
		return proto.AnnotationResult{
			AnnotationID: id,
			Status:       proto.StatusDone,
			Summary:      summary,
			Verification: &proto.Verification{Status: "passed", Summary: summary},
		}
	case "error":
		code, msg := "edit_failed", "annotation failed"
		if r.Error != nil {
			if r.Error.Code != "" {
				code = r.Error.Code
			}
			if r.Error.Message != "" {
				msg = r.Error.Message
			}
		}
		return proto.AnnotationResult{
			AnnotationID: id,
			Status:       proto.StatusError,
			Error:        &proto.Error{Code: code, Message: msg},
		}
	default:
		return proto.AnnotationResult{
			AnnotationID: id,
			Status:       proto.StatusError,
			Error:        &proto.Error{Code: "hermes_outcome_unparseable", Message: "unknown annotation status " + strconv.Quote(r.Status)},
		}
	}
}

// rollupSummary builds a job-level summary consistent with the per-annotation
// results (used by handleJob after normalization).
func rollupSummary(results []proto.AnnotationResult) string {
	done := 0
	for _, r := range results {
		if r.Status == proto.StatusDone {
			done++
		}
	}
	return fmt.Sprintf("%d of %d annotations done", done, len(results))
}

var (
	h1RE  = regexp.MustCompile(`(?is)<h1[^>]*>(.*?)</h1>`)
	tagRE = regexp.MustCompile(`<[^>]+>`)
)

// h1Texts returns the normalized text of every H1 element in the given HTML.
func h1Texts(html string) []string {
	var out []string
	for _, m := range h1RE.FindAllStringSubmatch(html, -1) {
		t := tagRE.ReplaceAllString(m[1], "")
		out = append(out, strings.TrimSpace(t))
	}
	return out
}

// postcondition is the deterministic defense-in-depth check for the whole
// (single-annotation) flow: after Hermes reports done, confirm the target file
// reflects the change. It is NOT a replacement for Hermes's own verification.
func postcondition(ctx SiteContext) (code, msg string, ok bool) {
	return postconditionTargets(ctx, ctx.Targets)
}

// postconditionFor runs the deterministic check for a single annotation (batch
// flow), keyed by annotationId.
func postconditionFor(ctx SiteContext, annotationID string) (code, msg string, ok bool) {
	for _, t := range ctx.Targets {
		if t.Annotation.AnnotationID == annotationID {
			return postconditionTargets(ctx, []ResolvedTarget{t})
		}
	}
	return "verification_failed", "postcondition: annotation not found", false
}

// postconditionTargets dispatches the deterministic check for the given targets
// to the site's editing mode.
func postconditionTargets(ctx SiteContext, targets []ResolvedTarget) (code, msg string, ok bool) {
	switch ctx.Config.EditingMode {
	case editingModeYoothemeMCP:
		return mcpPostconditionTargets(ctx, targets)
	case editingModeEmdash:
		return emdashPostconditionTargets(ctx, targets)
	}
	return filesystemPostconditionTargets(ctx, targets)
}

// filesystemPostconditionTargets confirms the previous visible text no longer
// appears in any H1 of the given targets' files.
func filesystemPostconditionTargets(ctx SiteContext, targets []ResolvedTarget) (code, msg string, ok bool) {
	for _, t := range targets {
		old := strings.TrimSpace(t.Annotation.Target.VisibleText)
		if old == "" {
			continue // nothing deterministic to check; trust Hermes
		}
		b, err := os.ReadFile(t.FilePath)
		if err != nil {
			return "verification_failed", "postcondition: cannot read edited file: " + err.Error(), false
		}
		for _, h := range h1Texts(string(b)) {
			if h == old {
				return "verification_failed", "postcondition: an H1 still contains the previous text", false
			}
		}
	}
	return "", "", true
}
