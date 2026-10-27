package main

// Schema-level tests for the optional job-wide session context (etapp 2,
// point 2): the Relay validates every Job payload at ingest against
// protocol/job.schema.json, so the field must be accepted there — and stay
// closed to anything else.

import (
	"encoding/json"
	"testing"
)

func jobPayloadWithContextFixture(t *testing.T) map[string]any {
	t.Helper()
	var env struct {
		Payload map[string]any `json:"payload"`
	}
	raw := loadFixture(t, "example-job.json")
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return env.Payload
}

func TestJobSchemaAcceptsSessionContext(t *testing.T) {
	payload := jobPayloadWithContextFixture(t)
	payload["context"] = map[string]any{"session": "Rework the services page for the autumn campaign."}
	if err := jobSchema.Validate(payload); err != nil {
		t.Fatalf("a job with a session description must validate: %v", err)
	}

	// Still valid without it (older jobs are unchanged).
	delete(payload, "context")
	if err := jobSchema.Validate(payload); err != nil {
		t.Fatalf("a job without context must still validate: %v", err)
	}
}

func TestJobSchemaRejectsUnknownContextFields(t *testing.T) {
	payload := jobPayloadWithContextFixture(t)
	payload["context"] = map[string]any{"session": "x", "agent": "someone-else"}
	if err := jobSchema.Validate(payload); err == nil {
		t.Fatal("context must be closed: an unknown field must fail validation")
	}

	// And the job-level object itself stays closed.
	payload = jobPayloadWithContextFixture(t)
	payload["session"] = "at the wrong level"
	if err := jobSchema.Validate(payload); err == nil {
		t.Fatal("the job object must stay closed: a stray session field must fail")
	}
}
