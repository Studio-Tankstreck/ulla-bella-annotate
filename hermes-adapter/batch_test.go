package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"ullabella-annotate/internal/proto"
)

// --- parse (pure) ---------------------------------------------------------

func TestParseHermesBatchOutcomeValid(t *testing.T) {
	content := `{"results":[` +
		`{"annotationId":"a","status":"done","summary":"s","verification":{"status":"passed","summary":"s"}},` +
		`{"annotationId":"b","status":"error","error":{"code":"edit_failed","message":"m"}}]}`
	rs, err := parseHermesBatchOutcome(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rs) != 2 {
		t.Fatalf("want 2 results, got %d", len(rs))
	}
	if rs[0].AnnotationID != "a" || rs[0].Status != proto.StatusDone || rs[0].Verification == nil {
		t.Fatalf("rs[0] = %+v", rs[0])
	}
	if rs[1].AnnotationID != "b" || rs[1].Status != proto.StatusError || rs[1].Error == nil || rs[1].Error.Code != "edit_failed" {
		t.Fatalf("rs[1] = %+v", rs[1])
	}
}

func TestParseHermesBatchOutcomeMalformed(t *testing.T) {
	for _, c := range []string{"not json at all", `{"results":[]}`, `{"foo":1}`, `[]`} {
		if _, err := parseHermesBatchOutcome(c); err == nil {
			t.Fatalf("expected error for %q", c)
		}
	}
}

func TestParseHermesBatchOutcomePerEntryNeverDone(t *testing.T) {
	// done-without-verification, missing annotationId, and unknown status must
	// all become error results (never "done").
	content := `{"results":[` +
		`{"annotationId":"a","status":"done"},` +
		`{"status":"done","verification":{"status":"passed","summary":"x"}},` +
		`{"annotationId":"c","status":"weird"}]}`
	rs, err := parseHermesBatchOutcome(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rs) != 3 {
		t.Fatalf("want 3 results, got %d", len(rs))
	}
	if rs[0].Status != proto.StatusError || rs[0].Error == nil || rs[0].Error.Code != "verification_failed" {
		t.Fatalf("rs[0] (done without verification) = %+v", rs[0])
	}
	if rs[1].AnnotationID != "" {
		t.Fatalf("rs[1] (missing id) should have empty id, got %q", rs[1].AnnotationID)
	}
	if rs[2].Status != proto.StatusError {
		t.Fatalf("rs[2] (unknown status) = %+v", rs[2])
	}
}

// --- batch execution (fakeRuns backend from runs_test.go) -----------------

type batchAnn struct {
	id   string
	path string // URL path under the origin, e.g. "/a"
	old  string // previous visible text (the deterministic postcondition needle)
	h1   string // file H1 content (new text if edited, old text if not)
}

func multiSiteContext(t *testing.T, anns []batchAnn) SiteContext {
	t.Helper()
	dir := t.TempDir()
	cfg := devSites()["site_01j7x9k2m"]
	cfg.Workspace = dir
	jb := proto.Job{JobID: "job_batch", SiteID: cfg.SiteID, DeviceID: "dev_test"}
	var targets []ResolvedTarget
	for _, a := range anns {
		url := cfg.Origin + a.path
		p, err := resolveWorkspaceFile(cfg, url)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<html><h1>"+a.h1+"</h1></html>"), 0o644); err != nil {
			t.Fatal(err)
		}
		ann := proto.Annotation{
			AnnotationID: a.id,
			Instruction:  "Change this",
			Target:       proto.Target{URL: url, ElementType: "h1", VisibleText: a.old},
		}
		jb.Annotations = append(jb.Annotations, ann)
		targets = append(targets, ResolvedTarget{Annotation: ann, FilePath: p})
	}
	return SiteContext{Config: cfg, Job: jb, Targets: targets}
}

// batchOutput builds the raw run output (the Hermes final-response text) for a
// multi-annotation result.
func batchOutput(t *testing.T, results []map[string]any) string {
	t.Helper()
	content, err := json.Marshal(map[string]any{"results": results})
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func doneRes(id string) map[string]any {
	return map[string]any{"annotationId": id, "status": "done", "summary": "ok", "verification": map[string]any{"status": "passed", "summary": "ok"}}
}

func TestBatchAllDone(t *testing.T) {
	h, _ := newRunsExecutor(t, batchOutput(t, []map[string]any{doneRes("a"), doneRes("b"), doneRes("c")}))
	out := h.Execute(multiSiteContext(t, []batchAnn{
		{id: "a", path: "/a", old: "Old A", h1: "New A"},
		{id: "b", path: "/b", old: "Old B", h1: "New B"},
		{id: "c", path: "/c", old: "Old C", h1: "New C"},
	}))
	if out.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", out)
	}
	if len(out.AnnotationResults) != 3 {
		t.Fatalf("want 3 annotationResults, got %d", len(out.AnnotationResults))
	}
	for _, r := range out.AnnotationResults {
		if r.Status != proto.StatusDone {
			t.Fatalf("annotation %s should be done: %+v", r.AnnotationID, r)
		}
	}
}

func TestBatchOneFailsPostcondition(t *testing.T) {
	// Hermes reports all three done, but annotation c's file still contains the
	// old text -> the deterministic postcondition must downgrade it to error.
	h, _ := newRunsExecutor(t, batchOutput(t, []map[string]any{doneRes("a"), doneRes("b"), doneRes("c")}))
	out := h.Execute(multiSiteContext(t, []batchAnn{
		{id: "a", path: "/a", old: "Old A", h1: "New A"},
		{id: "b", path: "/b", old: "Old B", h1: "New B"},
		{id: "c", path: "/c", old: "Old C", h1: "Old C"}, // unchanged
	}))
	if out.Status != proto.StatusDone {
		t.Fatalf("job should still be done (processed): %+v", out)
	}
	byID := map[string]proto.AnnotationResult{}
	for _, r := range out.AnnotationResults {
		byID[r.AnnotationID] = r
	}
	if byID["a"].Status != proto.StatusDone || byID["b"].Status != proto.StatusDone {
		t.Fatalf("a/b should be done: %+v", out.AnnotationResults)
	}
	if byID["c"].Status != proto.StatusError || byID["c"].Error == nil || byID["c"].Error.Code != "verification_failed" {
		t.Fatalf("c should be verification_failed: %+v", byID["c"])
	}
}

func TestBatchHermesReportsError(t *testing.T) {
	h, _ := newRunsExecutor(t, batchOutput(t, []map[string]any{
		doneRes("a"), doneRes("b"),
		{"annotationId": "c", "status": "error", "error": map[string]any{"code": "edit_failed", "message": "cannot find element"}},
	}))
	out := h.Execute(multiSiteContext(t, []batchAnn{
		{id: "a", path: "/a", old: "Old A", h1: "New A"},
		{id: "b", path: "/b", old: "Old B", h1: "New B"},
		{id: "c", path: "/c", old: "Old C", h1: "Old C"},
	}))
	byID := map[string]proto.AnnotationResult{}
	for _, r := range out.AnnotationResults {
		byID[r.AnnotationID] = r
	}
	if byID["c"].Status != proto.StatusError || byID["c"].Error == nil || byID["c"].Error.Code != "edit_failed" {
		t.Fatalf("c should carry Hermes's edit_failed: %+v", byID["c"])
	}
}

// --- handleJob integration: normalize + rollup summary --------------------

type batchExecutor struct{ results []proto.AnnotationResult }

func (b batchExecutor) Execute(SiteContext) Outcome {
	return Outcome{Status: proto.StatusDone, AnnotationResults: b.results}
}

func TestHandleJobBatchNormalizeAndSummary(t *testing.T) {
	jb := proto.Job{
		JobID:    "job_b",
		SiteID:   "site_01j7x9k2m",
		DeviceID: "dev_test",
		Annotations: []proto.Annotation{
			{AnnotationID: "a", Instruction: "x", Target: proto.Target{URL: "https://example.test/a"}},
			{AnnotationID: "b", Instruction: "x", Target: proto.Target{URL: "https://example.test/b"}},
			{AnnotationID: "c", Instruction: "x", Target: proto.Target{URL: "https://example.test/c"}},
		},
	}
	rec := batchExecutor{results: []proto.AnnotationResult{
		{AnnotationID: "a", Status: proto.StatusDone},
		{AnnotationID: "b", Status: proto.StatusDone},
		{AnnotationID: "z", Status: proto.StatusDone},  // unknown -> dropped
		{AnnotationID: "a", Status: proto.StatusError}, // duplicate -> dropped
	}}
	res := handleJob(devSites(), rec, jb)
	if res.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", res)
	}
	if len(res.AnnotationResults) != 3 {
		t.Fatalf("want 3 normalized results, got %d", len(res.AnnotationResults))
	}
	if res.AnnotationResults[2].AnnotationID != "c" || res.AnnotationResults[2].Status != proto.StatusError || res.AnnotationResults[2].Error == nil || res.AnnotationResults[2].Error.Code != "no_result" {
		t.Fatalf("c should be filled as no_result: %+v", res.AnnotationResults[2])
	}
	if res.Summary != "2 of 3 annotations done" {
		t.Fatalf("summary = %q, want %q", res.Summary, "2 of 3 annotations done")
	}
}

// --- single-annotation back-compat ---------------------------------------

func TestSingleAnnotationStillJobLevel(t *testing.T) {
	// A single annotation must keep the job-level outcome and NOT gain
	// annotationResults (backward compatibility for older clients).
	h, _ := newRunsExecutor(t, doneOutput)
	out := h.Execute(siteContext(t, "Our Services"))
	if out.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", out)
	}
	if out.AnnotationResults != nil {
		t.Fatalf("single-annotation job must not carry annotationResults: %+v", out.AnnotationResults)
	}
}
