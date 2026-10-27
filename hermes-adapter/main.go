package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"ullabella-annotate/internal/proto"
)

const (
	defaultConfigPath = "/etc/ulla-bella/adapter.yaml"
	initialBackoff    = time.Second
	maxBackoff        = 30 * time.Second
)

// defaultAdmissionGrace bounds how long an "admission_in_flight" record may be
// re-admitted. Hermes retains an idempotency reservation for 24 h and never
// prunes a non-terminal run's row, so re-admission with the same Idempotency-Key
// is safe for at least 24 h from admission. We use a 1 h margin (23 h): a record
// older than that is never re-admitted — it is marked uncertain for review.
const defaultAdmissionGrace = 23 * time.Hour

// recoveryGuard single-flights per-job recovery so two overlapping reconcile
// passes (e.g. back-to-back reconnects) never run competing admission attempts
// for the same job.
type recoveryGuard struct {
	mu     sync.Mutex
	active map[string]bool
}

func newRecoveryGuard() *recoveryGuard { return &recoveryGuard{active: map[string]bool{}} }

func (g *recoveryGuard) tryClaim(jobID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[jobID] {
		return false
	}
	g.active[jobID] = true
	return true
}

func (g *recoveryGuard) release(jobID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.active, jobID)
}

// admissionGrace returns the re-admission grace window (env-overridable).
func admissionGrace() time.Duration {
	if v := os.Getenv("ADAPTER_ADMISSION_GRACE"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
		log.Printf("adapter: invalid ADAPTER_ADMISSION_GRACE %q; using default", v)
	}
	return defaultAdmissionGrace
}

// admissionExpired reports whether an "admission_in_flight" record has outlived
// the idempotency grace window and must therefore be marked uncertain instead
// of re-admitted. A missing/unparseable timestamp fails closed (expired).
func admissionExpired(rec RunRecord) bool {
	t, err := time.Parse(time.RFC3339, rec.AttemptedAt)
	if err != nil {
		return true
	}
	return time.Since(t) >= admissionGrace()
}

func main() {
	cfgPath, envFile, cmd, _ := parseArgs(os.Args[1:])

	if envFile != "" {
		if err := loadEnvFile(envFile); err != nil {
			log.Fatalf("adapter: load env file: %v", err)
		}
	}

	switch cmd {
	case "version", "--version", "-version":
		printVersion()
	case "validate":
		os.Exit(runValidate(cfgPath))
	case "doctor":
		os.Exit(runDoctor(cfgPath))
	case "help", "-h", "--help":
		printUsage(os.Stdout)
	case "":
		serve(cfgPath)
	default:
		fmt.Fprintf(os.Stderr, "adapter: unknown command %q\n\n", cmd)
		printUsage(os.Stderr)
		os.Exit(2)
	}
}

// runDBPath is the Adapter's durable job→run store location. It follows the
// Relay's RELAY_DB_FILE convention: an env override, defaulting to a file in
// the working directory (the systemd unit pins an explicit path).
func runDBPath() string {
	return proto.EnvOr("ADAPTER_RUN_DB", "ulla-bella-runs.db")
}

// serve runs the Adapter service. With ADAPTER_MODE set to "stub" or "hermes" it
// keeps the Task 06-12 env-var driven development path (hardcoded dev sites);
// otherwise it loads a real config file (the production / installed-service path).
func serve(cfgPath string) {
	switch os.Getenv("ADAPTER_MODE") {
	case "stub", "hermes":
		serveLegacy(os.Getenv("ADAPTER_MODE"))
		return
	}

	cfg, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatalf("adapter: %v (use `%s --config %s validate` to check)", err, os.Args[0], cfgPath)
	}
	if errs := cfg.validate(); len(errs) > 0 {
		log.Fatalf("adapter: invalid config:\n%s", formatErrors(errs))
	}

	credential := os.Getenv(cfg.Agent.CredentialEnv)
	exec := newHermesExecutorConfig(cfg.Hermes)
	sites := cfg.siteMap()

	store, err := OpenRunStore(runDBPath())
	if err != nil {
		log.Fatalf("adapter: %v", err)
	}
	defer store.Close()
	exec.Store = store

	log.Printf("adapter: config loaded: agent=%s sites=%d relay=%s runDB=%s", cfg.Agent.ID, len(sites), cfg.Relay.URL, runDBPath())
	serveLoop(cfg.Relay.URL, cfg.Agent.ID, credential, exec, sites, store, newRecoveryGuard())
}

// serveLegacy preserves the Task 06-12 development path used by the scripted
// regression suite (scripts/demo*.sh). It is env-var driven and uses the
// hardcoded dev site mapping; production does not use it. No durable run store
// is attached, so there is no cross-restart recovery in this mode.
func serveLegacy(mode string) {
	relayAddr := proto.EnvOr("RELAY_ADDR", "127.0.0.1:8787")
	agentID := proto.EnvOr("ADAPTER_AGENT_ID", "agent_demo")
	credential := os.Getenv("ADAPTER_AGENT_CREDENTIAL")
	if credential == "" {
		log.Fatalf("adapter: ADAPTER_AGENT_CREDENTIAL is required (see `relay agent create`)")
	}
	wsURL := "ws://" + relayAddr + "/v1/ws"

	var exec Executor
	if mode == "hermes" {
		log.Printf("adapter: HermesExecutor (legacy hermes mode)")
		exec = NewHermesExecutor()
	} else {
		log.Printf("adapter: StubExecutor (legacy stub mode)")
		exec = StubExecutor{}
	}

	serveLoop(wsURL, agentID, credential, exec, devSites(), nil, nil)
}

// serveLoop connects, authenticates, serves Jobs, and reconnects with backoff on
// any failure (Relay restart, network blip, process-level errors). Backoff
// resets to initialBackoff after a successful registration, and grows to
// maxBackoff on repeated failures so a down Relay/Hermes is never hammered.
func serveLoop(wsURL, agentID, credential string, exec Executor, sites map[string]SiteConfig, store *RunStore, guard *recoveryGuard) {
	backoff := initialBackoff
	for {
		registered, err := run(wsURL, agentID, credential, exec, sites, store, guard)
		if err != nil {
			log.Printf("adapter: %v", err)
		}
		if registered {
			backoff = initialBackoff
		} else if backoff < maxBackoff {
			backoff *= 2
		}
		log.Printf("adapter: reconnecting in %s", backoff)
		time.Sleep(backoff)
	}
}

// run connects, authenticates as the agent, then serves Jobs until disconnect.
// It returns registered=true if authentication succeeded (so the caller can reset
// backoff) and err != nil on any failure. The Adapter never self-declares site
// ownership: it presents a credential and the Relay replies with the Sites it may
// serve; local config is intersected with that grant.
//
// With a non-nil store, run also recovers durable state on every (re)connection:
// in-flight runs are resumed and terminal results are re-delivered idempotently.
func run(wsURL, agentID, credential string, exec Executor, localSites map[string]SiteConfig, store *RunStore, guard *recoveryGuard) (bool, error) {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return false, err
	}
	defer conn.Close()

	reg := map[string]any{
		"type":       "register",
		"agentId":    agentID,
		"credential": credential,
	}
	if err := conn.WriteJSON(reg); err != nil {
		return false, err
	}

	// Await the registration ack. On auth failure the Relay closes the
	// connection, so a read error here means the credential was rejected.
	var ack struct {
		Type  string   `json:"type"`
		Sites []string `json:"sites"`
	}
	if err := conn.ReadJSON(&ack); err != nil {
		return false, fmt.Errorf("registration failed (check agent credential): %w", err)
	}
	if ack.Type != "registered" {
		return false, fmt.Errorf("registration rejected: type=%q", ack.Type)
	}

	sites, missing := effectiveSites(localSites, ack.Sites)
	if len(missing) > 0 {
		log.Printf("adapter: warning: Relay granted %d site(s) with no local tool config (will fail safely if routed): %v", len(missing), missing)
	}
	log.Printf("adapter: registered agentId=%s sites=%v", agentID, siteKeys(sites))

	// Job execution runs in a background goroutine so the read loop stays
	// responsive to the Relay's keepalive pings while a long edit runs. A slow
	// Hermes/MCP edit that outlives the Relay's pong wait would otherwise get
	// the connection dropped mid-job and the terminal result silently lost (the
	// poller then sees the stale "accepted" status until its own timeout).
	// A single-slot channel preserves the previous serial execution order; the
	// mutex serializes result writes (gorilla permits one concurrent writer).
	jobSlot := make(chan struct{}, 1)
	var wmu sync.Mutex
	writeResult := func(b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		return conn.WriteMessage(websocket.TextMessage, b)
	}

	// Live activity: while a durable Hermes run is in flight the executor
	// reports observed activity; forward it to the Relay as a non-terminal
	// "working" Result carrying the snapshot. The Relay stores it (last-write
	// wins) and the browser polls it via GET /v1/jobs/{jobId}. The jobId is
	// supplied by the executor from its own context, so the closure is safe to
	// share across every job/goroutine on this connection.
	if he, ok := exec.(*HermesExecutor); ok {
		he.OnActivity = func(jobID string, a proto.Activity) {
			emitActivityResult(writeResult, jobID, a)
		}
	}

	// Recovery runs on every (re)connection: a Relay restart or an Adapter crash
	// leaves durable run records that must be resumed (never re-admitted except
	// via the idempotent submit) and re-delivered.
	if store != nil {
		if he, ok := exec.(*HermesExecutor); ok {
			go reconcile(store, he, sites, writeResult, guard)
		} else {
			log.Printf("adapter: run store present but executor is not a HermesExecutor; recovery disabled")
		}
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return true, err
		}
		var env proto.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			log.Printf("adapter: ignoring non-envelope message: %v", err)
			continue
		}
		if env.MessageType != proto.MsgTypeJob {
			continue
		}
		var jb proto.Job
		if err := json.Unmarshal(env.Payload, &jb); err != nil {
			log.Printf("adapter: cannot decode job payload: %v", err)
			continue
		}
		log.Printf("adapter: received job jobId=%s siteId=%s annotations=%d", jb.JobID, jb.SiteID, len(jb.Annotations))

		// Persist the job BEFORE acknowledging receipt, so a crash at any point
		// after the Relay delivered it leaves a durable record to resume from.
		// If persistence fails we cannot guarantee recovery, so we fail the job
		// explicitly rather than proceed without the safety net.
		if store != nil {
			if err := store.EnsurePending(jb); err != nil {
				log.Printf("adapter: persist pending job %s: %v", jb.JobID, err)
				if errRes, e := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult,
					errorResult(jb.JobID, "adapter_store_error", "adapter could not persist job state"))); e == nil {
					_ = writeResult(errRes)
				}
				continue
			}
		}

		// Confirm delivery immediately so the Relay knows this job was received (and
		// can distinguish "delivered, awaiting result" from a lost write).
		if ack, err := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{JobID: jb.JobID, Status: proto.StatusWorking})); err == nil {
			if err := writeResult(ack); err != nil {
				log.Printf("adapter: write working ack: %v", err)
			}
		}

		go func(jb proto.Job) {
			jobSlot <- struct{}{}
			defer func() { <-jobSlot }()
			res := handleJob(sites, exec, jb)
			if store != nil {
				if err := store.SetTerminal(jb.JobID, res.Status, res); err != nil {
					log.Printf("adapter: persist terminal result for job %s: %v", jb.JobID, err)
				}
			}
			out, err := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, res))
			if err != nil {
				log.Printf("adapter: marshal result: %v", err)
				return
			}
			if err := writeResult(out); err != nil {
				log.Printf("adapter: write result: %v", err)
				return
			}
			log.Printf("adapter: returned %s result jobId=%s", res.Status, jb.JobID)
		}(jb)
	}
}

// emitActivityResult forwards one activity snapshot as a non-terminal "working"
// Result envelope to the Relay. It is best-effort: a write failure is logged,
// never treated as a job failure (the terminal result still follows).
func emitActivityResult(writeResult func([]byte) error, jobID string, a proto.Activity) {
	out, err := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
		JobID:    jobID,
		Status:   proto.StatusWorking,
		Activity: &a,
	}))
	if err != nil {
		log.Printf("adapter: marshal activity for job %s: %v", jobID, err)
		return
	}
	if err := writeResult(out); err != nil {
		log.Printf("adapter: write activity for job %s: %v", jobID, err)
	}
}

// reconcile resumes in-flight runs and re-delivers terminal results after a
// (re)connection. Each record is recovered in its own goroutine so the read loop
// stays responsive. Recovery never re-submits an uncertain run: a pending record
// is re-admitted through the idempotent submitRun (same Idempotency-Key → same
// run), and a running record is polled by its persisted run_id.
func reconcile(store *RunStore, exec *HermesExecutor, sites map[string]SiteConfig, writeResult func([]byte) error, guard *recoveryGuard) {
	deliver := func(res proto.Result) {
		out, err := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, res))
		if err != nil {
			log.Printf("adapter: reconcile marshal result: %v", err)
			return
		}
		if err := writeResult(out); err != nil {
			log.Printf("adapter: reconcile deliver result for job %s: %v", res.JobID, err)
		}
	}
	persistAndDeliver := func(jb proto.Job, o Outcome) {
		res := finalizeResult(jb, o)
		if err := store.SetTerminal(jb.JobID, res.Status, res); err != nil {
			log.Printf("adapter: reconcile persist terminal for job %s: %v", jb.JobID, err)
		}
		deliver(res)
	}

	active, err := store.ListActive()
	if err != nil {
		log.Printf("adapter: reconcile list active: %v", err)
	} else {
		for _, rec := range active {
			go func(rec RunRecord) {
				if guard != nil {
					if !guard.tryClaim(rec.JobID) {
						return // another recovery pass owns this job
					}
					defer guard.release(rec.JobID)
				}

				var jb proto.Job
				if err := json.Unmarshal(rec.Payload, &jb); err != nil {
					log.Printf("adapter: reconcile %s: cannot decode payload: %v", rec.JobID, err)
					return
				}
				ctx, o, ok := resolveJob(sites, jb)
				if !ok {
					persistAndDeliver(jb, o)
					return
				}
				switch rec.Status {
				case runReceived:
					// Provably unsent: re-admit safely (the first run is still the only run).
					persistAndDeliver(jb, exec.Execute(ctx))
				case runAdmissionInFlight:
					if admissionExpired(rec) {
						// Admission outcome unknown and the idempotency guarantee has
						// expired: never auto-re-admit — manual review required.
						persistAndDeliver(jb, errorOutcome("admission_uncertain",
							"run admission outcome is unknown and the idempotency guarantee has expired; manual review required"))
					} else {
						persistAndDeliver(jb, exec.Execute(ctx))
					}
				case runRunning:
					// run_id known: resume polling, never re-admit.
					persistAndDeliver(jb, exec.Resume(ctx, rec.RunID))
				default:
					log.Printf("adapter: reconcile %s: unknown active status %q", rec.JobID, rec.Status)
				}
			}(rec)
		}
	}

	terminal, err := store.ListTerminal()
	if err != nil {
		log.Printf("adapter: reconcile list terminal: %v", err)
	} else {
		for _, rec := range terminal {
			go func(rec RunRecord) {
				var res proto.Result
				if err := json.Unmarshal(rec.Result, &res); err != nil {
					log.Printf("adapter: reconcile re-deliver %s: decode result: %v", rec.JobID, err)
					return
				}
				deliver(res)
			}(rec)
		}
	}
}

// siteKeys returns the sorted Site IDs in the map (stable log output).
func siteKeys(sites map[string]SiteConfig) []string {
	keys := make([]string, 0, len(sites))
	for k := range sites {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// handleJob enforces the site-policy boundary, then dispatches to the executor
// and maps the outcome into the V1 Result envelope shape.
func handleJob(sites map[string]SiteConfig, exec Executor, jb proto.Job) proto.Result {
	ctx, o, ok := resolveJob(sites, jb)
	if !ok {
		return finalizeResult(jb, o)
	}
	return finalizeResult(jb, exec.Execute(ctx))
}

// resolveJob validates a Job against the site policy and resolves every
// annotation to a concrete target. On failure it returns a terminal error
// Outcome (ok=false); the executor must not be invoked.
func resolveJob(sites map[string]SiteConfig, jb proto.Job) (SiteContext, Outcome, bool) {
	cfg, ok := sites[jb.SiteID]
	if !ok {
		return SiteContext{}, errorOutcome("site_not_configured", "no site configuration for this siteId"), false
	}

	targets := make([]ResolvedTarget, 0, len(jb.Annotations))
	for _, ann := range jb.Annotations {
		if !sameOrigin(cfg.Origin, ann.Target.URL) {
			return SiteContext{}, errorOutcome("url_out_of_origin",
				fmt.Sprintf("annotation url %q is outside site origin %q", ann.Target.URL, cfg.Origin)), false
		}
		path := ""
		if cfg.EditingMode != editingModeYoothemeMCP && cfg.EditingMode != editingModeEmdash {
			p, err := resolveWorkspaceFile(cfg, ann.Target.URL)
			if err != nil {
				return SiteContext{}, errorOutcome("path_out_of_workspace", err.Error()), false
			}
			path = p
		}
		targets = append(targets, ResolvedTarget{Annotation: ann, FilePath: path})
	}

	return SiteContext{Config: cfg, Job: jb, Targets: targets}, Outcome{}, true
}

// finalizeResult normalizes per-annotation results, rolls up the summary, and
// maps the Outcome into the V1 Result envelope shape. It is shared by the
// normal job path and recovery so the two can never drift on result shape.
func finalizeResult(jb proto.Job, o Outcome) proto.Result {
	o.AnnotationResults = normalizeAnnotationResults(jb.Annotations, o.AnnotationResults)
	if len(o.AnnotationResults) > 0 {
		o.Summary = rollupSummary(o.AnnotationResults)
	}
	return outcomeToResult(jb.JobID, o)
}

// outcomeToResult maps an adapter Outcome into the V1 Result envelope shape.
func outcomeToResult(jobID string, o Outcome) proto.Result {
	res := proto.Result{JobID: jobID, Status: o.Status, Summary: o.Summary, Verification: o.Verification, AnnotationResults: o.AnnotationResults}
	if o.Status == proto.StatusError {
		res.Error = &proto.Error{Code: o.ErrorCode, Message: o.ErrorMessage}
	}
	return res
}

func errorResult(jobID, code, message string) proto.Result {
	return proto.Result{
		JobID:  jobID,
		Status: proto.StatusError,
		Error:  &proto.Error{Code: code, Message: message},
	}
}
