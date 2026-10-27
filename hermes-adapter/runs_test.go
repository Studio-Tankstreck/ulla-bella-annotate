package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
)

// fakeRuns is a scripted Hermes /v1/runs backend for Adapter tests. It admits
// runs on POST /v1/runs (honoring the Idempotency-Key so re-admission returns
// the same run_id) and serves a per-run sequence of statuses on
// GET /v1/runs/{run_id}.
type fakeRuns struct {
	t             *testing.T
	mu            sync.Mutex
	seq           map[string][]runStatus // run_id -> scripted statuses (polled in order, last repeats)
	idem          map[string]string      // Idempotency-Key -> run_id
	next          int
	admits        int
	defaultOutput string // output for auto-registered runs
	failNext      int    // fail the next N status GETs with HTTP 500
	failNextAdmit int    // fail the next N admission POSTs with HTTP 500 (after reserving the key)
	admitStatus   int    // when 4xx, return this status for every admission (definitive rejection)
	lastKey       string
	lastKeys      []string
	lastBodies    []string
}

func newFakeRuns(t *testing.T) *fakeRuns {
	t.Helper()
	return &fakeRuns{t: t, seq: map[string][]runStatus{}, idem: map[string]string{}}
}

// register pre-registers a run_id with a scripted status sequence.
func (f *fakeRuns) register(runID string, statuses ...runStatus) {
	f.seq[runID] = statuses
}

func (f *fakeRuns) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/runs":
			f.handleAdmit(w, r)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/runs/"):
			f.handleStatus(w, r)
		default:
			f.t.Errorf("fakeRuns: unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func (f *fakeRuns) handleAdmit(w http.ResponseWriter, r *http.Request) {
	if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
		f.t.Errorf("fakeRuns: auth header = %q", got)
	}
	key := r.Header.Get("Idempotency-Key")
	body, _ := io.ReadAll(r.Body)

	f.mu.Lock()
	defer f.mu.Unlock()
	f.admits++
	f.lastKey = key
	f.lastKeys = append(f.lastKeys, key)
	f.lastBodies = append(f.lastBodies, string(body))

	// A definitive rejection (4xx, e.g. 409 idempotency_key_conflict) never
	// creates a run and must never be retried.
	if f.admitStatus >= 400 && f.admitStatus < 500 {
		w.WriteHeader(f.admitStatus)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "idempotency_key_conflict"}})
		return
	}

	if key != "" {
		if existing, ok := f.idem[key]; ok {
			w.Header().Set("Idempotency-Replayed", "true")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"run_id": existing, "status": "started", "replayed": true})
			return
		}
	}
	id := fmt.Sprintf("run_test_%d", f.next)
	f.next++
	if key != "" {
		f.idem[key] = id
	}
	if _, ok := f.seq[id]; !ok {
		f.seq[id] = []runStatus{{Status: "running"}, {Status: "completed", Output: f.defaultOutput}}
	}
	// "Admitted but the response was dropped": the key is reserved (a run exists)
	// but the adapter sees a 500 — an UNCERTAIN outcome it must retry with the
	// same key.
	if f.failNextAdmit > 0 {
		f.failNextAdmit--
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"run_id": id, "status": "started", "replayed": false})
}

func (f *fakeRuns) handleStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/runs/")

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	seq, ok := f.seq[id]
	if !ok || len(seq) == 0 {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "run not found"}})
		return
	}
	st := seq[0]
	if len(seq) > 1 {
		f.seq[id] = seq[1:]
	}
	_ = json.NewEncoder(w).Encode(st)
}

// doneOutput is the raw run output (Hermes final-response text) for a single
// verified done annotation.
const doneOutput = `{"status":"done","summary":"H1 now reads Our Services","verification":{"status":"passed","summary":"H1 now reads Our Services"}}`

// newRunsExecutor builds a HermesExecutor backed by a fakeRuns server whose
// auto-registered runs complete with the given output. PollInterval is 1ms so
// scripted status sequences run fast.
func newRunsExecutor(t *testing.T, output string) (*HermesExecutor, *fakeRuns) {
	t.Helper()
	f := newFakeRuns(t)
	f.defaultOutput = output
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	h := &HermesExecutor{
		BaseURL:               srv.URL,
		APIKey:                "test-key",
		Model:                 "hermes-agent",
		Client:                srv.Client(),
		PollClient:            srv.Client(),
		PollInterval:          time.Millisecond,
		AdmissionRetryBackoff: time.Millisecond,
	}
	return h, f
}

// runsSite builds a filesystem SiteContext (workspace with the given H1) plus
// the sites map reconcile needs to re-resolve the job.
func runsSite(t *testing.T, h1 string) (SiteContext, map[string]SiteConfig) {
	t.Helper()
	ctx := siteContext(t, h1)
	return ctx, map[string]SiteConfig{ctx.Config.SiteID: ctx.Config}
}

// --- submitRun / pollRun ---

func TestSubmitRunIdempotentReAdmission(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	id1, err := h.submitRun("prompt", "ub-key-1")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	id2, err := h.submitRun("prompt", "ub-key-1")
	if err != nil {
		t.Fatalf("re-submit: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("re-admission with the same key must return the same run_id: %q vs %q", id1, id2)
	}
	if f.admits != 2 {
		t.Fatalf("admits = %d, want 2", f.admits)
	}
	// A different key must admit a different run.
	id3, err := h.submitRun("prompt", "ub-key-2")
	if err != nil {
		t.Fatalf("submit key2: %v", err)
	}
	if id3 == id1 {
		t.Fatalf("a different key must admit a different run")
	}
}

func TestPollRunCompletes(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_test_0", runStatus{Status: "completed", Output: doneOutput})
	out, err := h.pollRun("run_test_0")
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if out != doneOutput {
		t.Fatalf("output = %q", out)
	}
}

func TestPollRunLongRunSimulated(t *testing.T) {
	// A run that reports "running" several times before completing — standing in
	// for a >5-minute / >10-minute job without any real delay.
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_long",
		runStatus{Status: "running"}, runStatus{Status: "running"}, runStatus{Status: "running"},
		runStatus{Status: "running"}, runStatus{Status: "running"},
		runStatus{Status: "completed", Output: doneOutput})
	out, err := h.pollRun("run_long")
	if err != nil {
		t.Fatalf("poll long run: %v", err)
	}
	if out != doneOutput {
		t.Fatalf("output = %q", out)
	}
}

func TestPollRunToleratesTransientError(t *testing.T) {
	// A transient 500 during polling must not fail the run; the poll backs off
	// and retries until the run reaches a terminal status.
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_x", runStatus{Status: "running"}, runStatus{Status: "completed", Output: doneOutput})
	f.failNext = 1
	out, err := h.pollRun("run_x")
	if err != nil {
		t.Fatalf("poll should tolerate a transient error: %v", err)
	}
	if out != doneOutput {
		t.Fatalf("output = %q", out)
	}
}

func TestPollRunFailed(t *testing.T) {
	h, f := newRunsExecutor(t, "")
	f.register("run_fail", runStatus{Status: "failed", Error: "boom"})
	_, err := h.pollRun("run_fail")
	if err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("want a failed-run error, got %v", err)
	}
}

func TestPollRunInterrupted(t *testing.T) {
	h, f := newRunsExecutor(t, "")
	f.register("run_int", runStatus{Status: "interrupted", Error: "gateway restarted"})
	_, err := h.pollRun("run_int")
	if err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("want an interrupted-run error, got %v", err)
	}
}

func TestPollRunNotFound(t *testing.T) {
	h, _ := newRunsExecutor(t, "")
	_, err := h.pollRun("run_missing")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want a not-found error, got %v", err)
	}
}

func TestExecuteMalformedOutput(t *testing.T) {
	h, _ := newRunsExecutor(t, "this is not JSON")
	out := h.Execute(siteContext(t, "Our Services"))
	if out.Status != proto.StatusError || out.ErrorCode != "hermes_outcome_unparseable" {
		t.Fatalf("want hermes_outcome_unparseable, got %+v", out)
	}
}

// --- Resume + recovery ---

func TestResumePollsExistingRun(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_recover", runStatus{Status: "completed", Output: doneOutput})
	out := h.Resume(siteContext(t, "Our Services"), "run_recover")
	if out.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", out)
	}
	if f.admits != 0 {
		t.Fatalf("Resume must not admit a run, admits=%d", f.admits)
	}
}

func TestReconcileResumesRunningRun(t *testing.T) {
	ctx, sites := runsSite(t, "Our Services")
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_recover", runStatus{Status: "completed", Output: doneOutput})
	store := newTestRunStore(t)
	if err := store.EnsurePending(ctx.Job); err != nil {
		t.Fatal(err)
	}
	if err := store.SetRunID(ctx.Job.JobID, "run_recover"); err != nil {
		t.Fatal(err)
	}

	res := recoverOnce(t, store, h, sites)
	if res.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", res)
	}
	if f.admits != 0 {
		t.Fatalf("recovery of a running run must not re-admit, admits=%d", f.admits)
	}
	if rec, ok := store.GetRun(ctx.Job.JobID); !ok || rec.Status != "done" {
		t.Fatalf("store not terminal after recovery: %+v", rec)
	}
}

func TestReconcileReadmitsPendingRun(t *testing.T) {
	// Simulates the crash window: the job was persisted (pending) but the adapter
	// crashed before the run_id was recorded. Recovery must re-admit exactly one
	// run (idempotently) and complete it — never run it twice.
	ctx, sites := runsSite(t, "Our Services")
	h, f := newRunsExecutor(t, doneOutput)
	store := newTestRunStore(t)
	if err := store.EnsurePending(ctx.Job); err != nil {
		t.Fatal(err)
	}

	res := recoverOnce(t, store, h, sites)
	if res.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", res)
	}
	if f.admits != 1 {
		t.Fatalf("pending recovery should admit exactly one run, admits=%d", f.admits)
	}
	if rec, ok := store.GetRun(ctx.Job.JobID); !ok || rec.Status != "done" || rec.RunID == "" {
		t.Fatalf("store not terminal with a run_id: %+v", rec)
	}
}

// recoverOnce runs reconcile with a capture sink and returns the first terminal
// result it produces.
func recoverOnce(t *testing.T, store *RunStore, exec *HermesExecutor, sites map[string]SiteConfig) proto.Result {
	t.Helper()
	// Production wires the store into the executor in serve(); mirror that here
	// so Execute/Resume persist the run_id mapping during recovery.
	exec.Store = store
	results := make(chan proto.Result, 8)
	reconcile(store, exec, sites, func(b []byte) error {
		var env proto.Envelope
		if json.Unmarshal(b, &env) == nil && env.MessageType == proto.MsgTypeResult {
			var res proto.Result
			if json.Unmarshal(env.Payload, &res) == nil && (res.Status == proto.StatusDone || res.Status == proto.StatusError) {
				results <- res
			}
		}
		return nil
	}, nil)
	select {
	case res := <-results:
		return res
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for recovered result")
		return proto.Result{}
	}
}
