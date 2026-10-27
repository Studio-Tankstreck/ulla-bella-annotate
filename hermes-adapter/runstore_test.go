package main

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"ullabella-annotate/internal/proto"
)

// newTestRunStore opens a RunStore on a temp file and registers cleanup.
func newTestRunStore(t *testing.T) *RunStore {
	t.Helper()
	store, err := OpenRunStore(filepath.Join(t.TempDir(), "runs.db"))
	if err != nil {
		t.Fatalf("open run store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestRunStoreLifecycle(t *testing.T) {
	store := newTestRunStore(t)
	jb := canonicalJob()

	if err := store.EnsurePending(jb); err != nil {
		t.Fatal(err)
	}
	// EnsurePending is idempotent.
	if err := store.EnsurePending(jb); err != nil {
		t.Fatal(err)
	}

	rec, ok := store.GetRun(jb.JobID)
	if !ok || rec.Status != runReceived || rec.RunID != "" {
		t.Fatalf("received record = %+v", rec)
	}

	if err := store.SetRunID(jb.JobID, "run_1"); err != nil {
		t.Fatal(err)
	}
	rec, ok = store.GetRun(jb.JobID)
	if !ok || rec.Status != runRunning || rec.RunID != "run_1" {
		t.Fatalf("running record = %+v", rec)
	}

	active, err := store.ListActive()
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 1 || active[0].JobID != jb.JobID {
		t.Fatalf("active = %+v", active)
	}

	res := proto.Result{JobID: jb.JobID, Status: proto.StatusDone, Summary: "ok"}
	if err := store.SetTerminal(jb.JobID, proto.StatusDone, res); err != nil {
		t.Fatal(err)
	}

	active, err = store.ListActive()
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 0 {
		t.Fatalf("terminal job must not be active: %+v", active)
	}

	terminal, err := store.ListTerminal()
	if err != nil {
		t.Fatal(err)
	}
	if len(terminal) != 1 || terminal[0].Status != "done" {
		t.Fatalf("terminal = %+v", terminal)
	}
	if len(terminal[0].Result) == 0 {
		t.Fatal("terminal record must carry the result envelope")
	}
}

func TestRunStorePayloadRoundTrips(t *testing.T) {
	store := newTestRunStore(t)
	jb := canonicalJob()
	jb.Annotations[0].Instruction = "Change this heading to Our Services"

	if err := store.EnsurePending(jb); err != nil {
		t.Fatal(err)
	}
	rec, ok := store.GetRun(jb.JobID)
	if !ok {
		t.Fatal("record missing")
	}
	var decoded proto.Job
	if err := json.Unmarshal(rec.Payload, &decoded); err != nil {
		t.Fatalf("payload not valid job JSON: %v", err)
	}
	if decoded.JobID != jb.JobID || len(decoded.Annotations) != 1 || decoded.Annotations[0].Instruction != jb.Annotations[0].Instruction {
		t.Fatalf("payload did not round-trip: %+v", decoded)
	}
}
