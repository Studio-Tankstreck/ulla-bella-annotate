package main

import (
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
)

func TestRunStoreAdmissionStates(t *testing.T) {
	store := newTestRunStore(t)
	jb := canonicalJob()

	if err := store.EnsurePending(jb); err != nil {
		t.Fatal(err)
	}
	rec, _ := store.GetRun(jb.JobID)
	if rec.Status != runReceived {
		t.Fatalf("want received, got %q", rec.Status)
	}

	if err := store.MarkAdmissionInFlight(jb.JobID); err != nil {
		t.Fatal(err)
	}
	rec, _ = store.GetRun(jb.JobID)
	if rec.Status != runAdmissionInFlight || rec.AttemptedAt == "" {
		t.Fatalf("want admission_in_flight with a stamp, got %+v", rec)
	}
	firstAttempt := rec.AttemptedAt

	// Re-marking (re-admission within grace) must NOT reset the stamp, or the
	// grace clock could be extended past the idempotency window.
	time.Sleep(2 * time.Millisecond)
	if err := store.MarkAdmissionInFlight(jb.JobID); err != nil {
		t.Fatal(err)
	}
	rec, _ = store.GetRun(jb.JobID)
	if rec.AttemptedAt != firstAttempt {
		t.Fatalf("attempted_at must not be reset: %q vs %q", rec.AttemptedAt, firstAttempt)
	}

	if err := store.SetRunID(jb.JobID, "run_x"); err != nil {
		t.Fatal(err)
	}
	rec, _ = store.GetRun(jb.JobID)
	if rec.Status != runRunning || rec.RunID != "run_x" {
		t.Fatalf("want running, got %+v", rec)
	}
}

func TestAdmissionExpired(t *testing.T) {
	fresh := RunRecord{AttemptedAt: time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)}
	if admissionExpired(fresh) {
		t.Fatal("a fresh admission must not be expired")
	}
	old := RunRecord{AttemptedAt: time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339)}
	if !admissionExpired(old) {
		t.Fatal("a 25h-old admission must be expired (idempotency guarantee lapsed)")
	}
	// Fail closed on a missing/unparseable timestamp.
	if !admissionExpired(RunRecord{AttemptedAt: ""}) {
		t.Fatal("empty timestamp must fail closed (expired)")
	}
	if !admissionExpired(RunRecord{AttemptedAt: "not-a-time"}) {
		t.Fatal("unparseable timestamp must fail closed (expired)")
	}
}

func TestReconcileAdmissionInFlightWithinGrace(t *testing.T) {
	ctx, sites := runsSite(t, "Our Services")
	h, f := newRunsExecutor(t, doneOutput)
	store := newTestRunStore(t)
	if err := store.EnsurePending(ctx.Job); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkAdmissionInFlight(ctx.Job.JobID); err != nil {
		t.Fatal(err)
	}

	res := recoverOnce(t, store, h, sites)
	if res.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", res)
	}
	if f.admits != 1 {
		t.Fatalf("within-grace recovery should re-admit exactly once, admits=%d", f.admits)
	}
}

func TestReconcileAdmissionInFlightExpired(t *testing.T) {
	ctx, sites := runsSite(t, "Our Services")
	h, f := newRunsExecutor(t, doneOutput)
	store := newTestRunStore(t)
	if err := store.EnsurePending(ctx.Job); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkAdmissionInFlight(ctx.Job.JobID); err != nil {
		t.Fatal(err)
	}
	// Backdate the admission attempt past the grace window.
	if _, err := store.db.Exec(`UPDATE runs SET attempted_at = ? WHERE job_id = ?`,
		time.Now().UTC().Add(-25*time.Hour).Format(time.RFC3339), ctx.Job.JobID); err != nil {
		t.Fatal(err)
	}

	res := recoverOnce(t, store, h, sites)
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "admission_uncertain" {
		t.Fatalf("want admission_uncertain, got %+v", res)
	}
	if f.admits != 0 {
		t.Fatalf("expired admission must never re-admit, admits=%d", f.admits)
	}
	rec, ok := store.GetRun(ctx.Job.JobID)
	if !ok || rec.Status != "error" {
		t.Fatalf("store not terminal after uncertain admission: %+v", rec)
	}
}

func TestRecoveryGuardSingleFlight(t *testing.T) {
	g := newRecoveryGuard()
	if !g.tryClaim("job_1") {
		t.Fatal("first claim must succeed")
	}
	if g.tryClaim("job_1") {
		t.Fatal("second claim of the same job must be denied")
	}
	g.release("job_1")
	if !g.tryClaim("job_1") {
		t.Fatal("claim must succeed again after release")
	}
}
