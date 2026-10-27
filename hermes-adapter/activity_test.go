package main

import (
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
)

func TestActivityKindForEvent(t *testing.T) {
	cases := map[string]string{
		"tool.started":        activityUsingTools,
		"tool.completed":      activityUsingTools,
		"reasoning.available": activityThinking,
		"approval.request":    activityWaitingApproval,
		"message.interim":     activityWorking,
		"subagent.start":      activityWorking,
		"":                    activityWorking,
		"unknown.event":       activityWorking,
	}
	for ev, want := range cases {
		if got := activityKindForEvent(ev); got != want {
			t.Errorf("activityKindForEvent(%q) = %q, want %q", ev, got, want)
		}
	}
}

func TestActivityKindForStatusPrefersApprovalWait(t *testing.T) {
	if got := activityKindForStatus(runStatus{Status: "waiting_for_approval", LastEvent: "tool.started"}); got != activityWaitingApproval {
		t.Fatalf("waiting_for_approval must win over last_event: got %q", got)
	}
	if got := activityKindForStatus(runStatus{Status: "running", LastEvent: "tool.started"}); got != activityUsingTools {
		t.Fatalf("running + tool.started = %q, want using_tools", got)
	}
	if got := activityKindForStatus(runStatus{Status: "running"}); got != activityWorking {
		t.Fatalf("running with no event = %q, want working", got)
	}
}

func TestActivityTimeFallsBackToNow(t *testing.T) {
	before := time.Now()
	got := activityTime(runStatus{UpdatedAt: 0})
	if got.Before(before) {
		t.Fatalf("zero updated_at should fall back to now, got %v", got)
	}
	ts := float64(1730000000)
	got = activityTime(runStatus{UpdatedAt: ts})
	if got.Unix() != int64(ts) {
		t.Fatalf("activityTime(%v).Unix() = %d, want %d", ts, got.Unix(), int64(ts))
	}
}

func TestPollRunEmitReportsActivity(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_act",
		runStatus{Status: "running", LastEvent: "tool.started", UpdatedAt: 100},
		runStatus{Status: "running", LastEvent: "tool.completed", UpdatedAt: 101},
		runStatus{Status: "completed", Output: doneOutput, LastEvent: "tool.completed", UpdatedAt: 102})

	var got []proto.Activity
	h.OnActivity = func(_ string, a proto.Activity) { got = append(got, a) }

	if _, err := h.pollRunEmit("job_act", "run_act"); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("emitted %d activities, want 2: %+v", len(got), got)
	}
	if got[0].Kind != activityUsingTools || got[1].Kind != activityUsingTools {
		t.Fatalf("kinds = %q,%q, want using_tools for both", got[0].Kind, got[1].Kind)
	}
	if got[0].ActivityAt == "" || got[0].CheckedAt == "" {
		t.Fatalf("activity timestamps missing: %+v", got[0])
	}
}

func TestPollRunEmitNoActivityEventsReportsWorking(t *testing.T) {
	// A run with no last_event (no observable agent events) is still provably
	// active — it must be reported as "working", never fabricated as finer
	// activity, and never reported as unavailable.
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_quiet",
		runStatus{Status: "running"},
		runStatus{Status: "completed", Output: doneOutput})

	var kinds []string
	h.OnActivity = func(_ string, a proto.Activity) { kinds = append(kinds, a.Kind) }

	if _, err := h.pollRunEmit("job_quiet", "run_quiet"); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(kinds) == 0 || kinds[len(kinds)-1] != activityWorking {
		t.Fatalf("want a working emission for a quiet run, got %v", kinds)
	}
	for _, k := range kinds {
		if k != activityWorking {
			t.Fatalf("quiet run must only report working, got %q", k)
		}
	}
}

func TestPollRunEmitTransientErrorDoesNotFabricateActivity(t *testing.T) {
	// A transient poll failure yields no successful status read, so no activity
	// may be emitted from it — activity is only ever what was actually observed.
	h, f := newRunsExecutor(t, doneOutput)
	f.register("run_blip", runStatus{Status: "completed", Output: doneOutput})
	f.failNext = 1

	var got []proto.Activity
	h.OnActivity = func(_ string, a proto.Activity) { got = append(got, a) }

	if _, err := h.pollRunEmit("job_blip", "run_blip"); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("emitted %d activities from a transient-error-only run, want 0: %+v", len(got), got)
	}
}

func TestRunEmitsStartingAfterAdmission(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	var kinds []string
	h.OnActivity = func(_ string, a proto.Activity) { kinds = append(kinds, a.Kind) }

	out := h.Execute(siteContext(t, "Our Services"))
	if out.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", out)
	}
	if len(kinds) == 0 || kinds[0] != activityStarting {
		t.Fatalf("first emission must be starting, got %v", kinds)
	}
	if f.admits != 1 {
		t.Fatalf("admits = %d, want 1", f.admits)
	}
}
