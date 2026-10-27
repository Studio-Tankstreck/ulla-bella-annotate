package main

import (
	"time"

	"ullabella-annotate/internal/proto"
)

// Activity kinds — the controlled, presentation-ready vocabulary the Adapter
// forwards to the Relay (and on to the browser). Only these strings ever leave
// the Adapter; raw Hermes tool names, previews and event internals are never
// forwarded. "Verifying" is adapter-only (the deterministic postcondition that
// runs after Hermes settles); the rest are mapped from Hermes's run activity.
const (
	activityStarting        = "starting"
	activityWorking         = "working"
	activityUsingTools      = "using_tools"
	activityThinking        = "thinking"
	activityWaitingApproval = "waiting_for_approval"
	activityVerifying       = "verifying"
)

// activityKindForEvent maps a Hermes run last_event name to a controlled
// activity kind. An empty or unrecognized event maps to "working": the run is
// provably active, but no finer-grained signal is available.
func activityKindForEvent(lastEvent string) string {
	switch lastEvent {
	case "tool.started", "tool.completed":
		return activityUsingTools
	case "reasoning.available":
		return activityThinking
	case "approval.request":
		return activityWaitingApproval
	default:
		return activityWorking
	}
}

// activityKindForStatus maps a run status to a controlled activity kind,
// preferring an explicit approval wait over the last-event name.
func activityKindForStatus(st runStatus) string {
	if st.Status == "waiting_for_approval" {
		return activityWaitingApproval
	}
	return activityKindForEvent(st.LastEvent)
}

// activityTime returns the run's last-activity time (Hermes updated_at) or now
// when the field is absent/zero (defensive: a successful poll is itself a
// signal the run exists).
func activityTime(st runStatus) time.Time {
	if st.UpdatedAt > 0 {
		return time.Unix(int64(st.UpdatedAt), 0)
	}
	return time.Now()
}

// activityHeartbeat returns the minimum delay between repeated activity
// emissions for a single job (0 → 5s default).
func (h *HermesExecutor) activityHeartbeat() time.Duration {
	if h.ActivityHeartbeat > 0 {
		return h.ActivityHeartbeat
	}
	return 5 * time.Second
}

// admissionRetryBackoff returns the initial backoff between admission retries
// after an uncertain (network/timeout/5xx) failure (0 → 500ms default).
func (h *HermesExecutor) admissionRetryBackoff() time.Duration {
	if h.AdmissionRetryBackoff > 0 {
		return h.AdmissionRetryBackoff
	}
	return 500 * time.Millisecond
}

// emitActivity reports one observed activity snapshot via OnActivity (a no-op
// when no sink is wired, e.g. tests or a non-Hermes executor).
func (h *HermesExecutor) emitActivity(jobID, kind string, at time.Time) {
	if h.OnActivity == nil {
		return
	}
	a := proto.Activity{
		Kind:       kind,
		ActivityAt: at.UTC().Format(time.RFC3339),
		CheckedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	h.OnActivity(jobID, a)
}
