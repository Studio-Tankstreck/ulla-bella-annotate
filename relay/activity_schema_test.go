package main

import "testing"

// TestWorkingResultWithActivityValidates pins that the additive "activity" field
// on a non-terminal "working" Result is accepted by the result schema, so the
// Relay does not drop the live-activity updates the Adapter emits.
func TestWorkingResultWithActivityValidates(t *testing.T) {
	working := map[string]any{
		"jobId":  "job_x",
		"status": "working",
		"activity": map[string]any{
			"kind":       "using_tools",
			"activityAt": "2026-10-16T00:00:00Z",
			"checkedAt":  "2026-10-16T00:00:01Z",
		},
	}
	if err := resultSchema.Validate(working); err != nil {
		t.Fatalf("working result with activity should validate: %v", err)
	}
}

func TestActivityRequiresKnownKind(t *testing.T) {
	working := map[string]any{
		"jobId":  "job_x",
		"status": "working",
		"activity": map[string]any{
			"kind": "not_a_real_kind",
		},
	}
	if err := resultSchema.Validate(working); err == nil {
		t.Fatal("activity with an unknown kind should be rejected")
	}
}

func TestActivityRejectsSecretLikeFields(t *testing.T) {
	// The activity object is closed: it must not accept arbitrary extra fields
	// (which could carry tool results or prompt content).
	working := map[string]any{
		"jobId":  "job_x",
		"status": "working",
		"activity": map[string]any{
			"kind":   "working",
			"result": "SENSITIVE TOOL OUTPUT",
		},
	}
	if err := resultSchema.Validate(working); err == nil {
		t.Fatal("activity with an unexpected field should be rejected")
	}
}
