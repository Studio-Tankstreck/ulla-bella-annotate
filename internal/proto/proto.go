// Package proto holds the V1 wire types shared by the Relay, Adapter Stub and
// scripted client. It is agent-agnostic: nothing here is Hermes-specific.
package proto

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"time"
)

// Version is the protocol version carried in the envelope's schemaVersion field.
const Version = "1"

// Message types.
const (
	MsgTypeJob    = "job"
	MsgTypeResult = "result"
)

// Result statuses.
const (
	StatusAccepted = "accepted"
	StatusWorking  = "working"
	StatusDone     = "done"
	StatusError    = "error"
)

// Envelope is the common wrapper for every protocol message.
type Envelope struct {
	SchemaVersion string          `json:"schemaVersion"`
	MessageType   string          `json:"messageType"`
	ID            string          `json:"id"`
	Timestamp     string          `json:"timestamp"`
	Payload       json.RawMessage `json:"payload"`
}

// Job is the unit of work: one Device, one Site, one or more Annotations.
type Job struct {
	JobID       string       `json:"jobId"`
	SiteID      string       `json:"siteId"`
	DeviceID    string       `json:"deviceId"`
	CreatedAt   string       `json:"createdAt"`
	Annotations []Annotation `json:"annotations"`
	// Context is the optional, job-wide context the user wrote for this
	// session. It applies to every annotation and is never a task of its own.
	Context *JobContext `json:"context,omitempty"`
	// AgentID pins the round to one authorized agent. Optional: a job without it
	// keeps the pre-etapp-3 behaviour (the Relay picks an authorized, connected
	// agent for the site). The Relay validates this value against agent_sites —
	// it is never trusted from the client.
	AgentID string `json:"agentId,omitempty"`
}

// JobContext is the job-wide context shared by all annotations of one session.
// The only field today is the user's session description; it is optional so
// jobs submitted before it existed keep working unchanged.
type JobContext struct {
	Session string `json:"session,omitempty"`
}

// Annotation is "this thing on this page -> this change".
type Annotation struct {
	AnnotationID string         `json:"annotationId"`
	Instruction  string         `json:"instruction"`
	Target       Target         `json:"target"`
	Context      map[string]any `json:"context,omitempty"`
}

// Target describes where the element is. URL is the durable identity; the rest
// are best-effort hints and must never be the sole source of truth.
type Target struct {
	URL         string `json:"url"`
	PageTitle   string `json:"pageTitle,omitempty"`
	ElementType string `json:"elementType,omitempty"`
	VisibleText string `json:"visibleText,omitempty"`
	Selector    string `json:"selector,omitempty"`
	DomPath     string `json:"domPath,omitempty"`
	Rect        any    `json:"rect,omitempty"`
}

// Result is the agent-side outcome for a Job.
type Result struct {
	JobID             string             `json:"jobId"`
	Status            string             `json:"status"`
	Summary           string             `json:"summary,omitempty"`
	Verification      *Verification      `json:"verification,omitempty"`
	Error             *Error             `json:"error,omitempty"`
	AnnotationResults []AnnotationResult `json:"annotationResults,omitempty"`
	Activity          *Activity          `json:"activity,omitempty"`
}

// Activity is a live, non-terminal activity snapshot carried on a "working"
// Result while a Job is in flight. It carries only safe metadata — never tool
// names, previews, results, or internal prompt content.
type Activity struct {
	Kind       string `json:"kind"`       // controlled enum: starting|working|using_tools|thinking|waiting_for_approval|verifying
	ActivityAt string `json:"activityAt"` // RFC3339 — last real agent activity (Hermes run updated_at)
	CheckedAt  string `json:"checkedAt"`  // RFC3339 — adapter's last successful Hermes status poll
}

// AnnotationResult is the per-annotation outcome inside a Result. It lets a
// single Job carry a mix of done and failed annotations while the job-level
// status still reports the transport lifecycle (accepted/working/done/error).
type AnnotationResult struct {
	AnnotationID string        `json:"annotationId"`
	Status       string        `json:"status"` // done | error
	Summary      string        `json:"summary,omitempty"`
	Verification *Verification `json:"verification,omitempty"`
	Error        *Error        `json:"error,omitempty"`
}

// Verification proves the agent checked its own result.
type Verification struct {
	Status  string `json:"status"`
	Summary string `json:"summary,omitempty"`
}

// Error is a terminal failure.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NewID returns a random hex id, sufficient for message correlation.
func NewID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewEnvelope wraps payload into a V1 envelope with a fresh id and timestamp.
func NewEnvelope(messageType string, payload any) Envelope {
	b, _ := json.Marshal(payload)
	return Envelope{
		SchemaVersion: Version,
		MessageType:   messageType,
		ID:            NewID(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       b,
	}
}

// EnvOr reads an environment variable or returns a default.
func EnvOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
