package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// runStatus is the pollable status returned by GET /v1/runs/{run_id}. Only the
// fields the Adapter consumes are decoded; the rest of the Hermes wire shape
// (object, usage, runtime, timestamps, …) is ignored.
type runStatus struct {
	Status    string  `json:"status"`
	Output    string  `json:"output"`
	Error     string  `json:"error"`
	LastEvent string  `json:"last_event"`
	UpdatedAt float64 `json:"updated_at"`
}

// errRunNotFound marks a GET /v1/runs/{run_id} that returned 404: the run was
// never known, already pruned, or belongs to a different scope.
var errRunNotFound = errors.New("hermes run not found")

// terminalRunStatuses are the Hermes run states that settle a run (see
// gateway/platforms/api_server_run_idempotency.py TERMINAL_STATUSES).
var terminalRunStatuses = map[string]bool{
	"completed":   true,
	"failed":      true,
	"cancelled":   true,
	"interrupted": true,
}

// idempotencyKey derives a stable, ASCII-safe Idempotency-Key from a jobId.
// Hermes requires 1-255 visible ASCII characters; the hex digest guarantees
// that regardless of the jobId's shape, and ties the key deterministically to
// the job so a re-admission after a crash resolves to the same run.
func idempotencyKey(jobID string) string {
	sum := sha256.Sum256([]byte(jobID))
	return "ub-" + hex.EncodeToString(sum[:])
}

// pollClient returns the client used for run-status polling. A separate
// short-timeout client (vs. the executor's general Client) ensures a hung
// status GET fails fast and is retried, rather than blocking a poll cycle for
// the executor's full default timeout.
func (h *HermesExecutor) pollClient() *http.Client {
	if h.PollClient != nil {
		return h.PollClient
	}
	if h.Client != nil {
		return h.Client
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// pollInterval returns the delay between run-status polls.
func (h *HermesExecutor) pollInterval() time.Duration {
	if h.PollInterval > 0 {
		return h.PollInterval
	}
	return 2 * time.Second
}

// submitRun admits a durable run for the given prompt and returns its run_id.
// The Idempotency-Key makes re-admission safe: a re-POST with the same key and
// identical body returns the original run_id (202 with Idempotency-Replayed),
// never a second execution. An UNCERTAIN admission failure (a network error or a
// 5xx, where the POST may have reached Hermes) is retried a bounded number of
// times with the SAME key + identical body, so a submit-time disconnect recovers
// the original run instead of failing (or, worse, re-running it). A definitive
// rejection (4xx, e.g. 409 idempotency_key_conflict) fails immediately.
func (h *HermesExecutor) submitRun(prompt, idemKey string) (string, error) {
	reqBody, err := json.Marshal(map[string]any{
		"model": h.Model,
		"input": prompt,
	})
	if err != nil {
		return "", err
	}
	const maxAttempts = 5
	backoff := h.admissionRetryBackoff()
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(backoff)
			if backoff < 5*time.Second {
				backoff *= 2
			}
		}
		runID, err := h.submitRunOnce(reqBody, idemKey)
		if err == nil {
			return runID, nil
		}
		lastErr = err
		if !isUncertainAdmissionError(err) {
			return "", err
		}
	}
	return "", fmt.Errorf("hermes run admission failed after %d attempts: %w", maxAttempts, lastErr)
}

// submitRunOnce performs one admission POST. It returns an admissionUncertain
// error when the outcome is unknown (network error or 5xx) so the caller can
// retry safely with the same Idempotency-Key.
func (h *HermesExecutor) submitRunOnce(reqBody []byte, idemKey string) (string, error) {
	req, err := http.NewRequest(http.MethodPost, h.BaseURL+"/v1/runs", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.APIKey)
	req.Header.Set("Idempotency-Key", idemKey)

	resp, err := h.Client.Do(req)
	if err != nil {
		return "", &admissionUncertain{cause: fmt.Errorf("hermes run admission request: %w", err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 500 {
		return "", &admissionUncertain{cause: hermesError(resp.StatusCode, body, "hermes run admission")}
	}
	if resp.StatusCode != http.StatusAccepted {
		return "", hermesError(resp.StatusCode, body, "hermes run admission")
	}
	var ar struct {
		RunID string `json:"run_id"`
	}
	if err := json.Unmarshal(body, &ar); err != nil || ar.RunID == "" {
		return "", fmt.Errorf("hermes returned a malformed run admission")
	}
	return ar.RunID, nil
}

// admissionUncertain marks an admission whose outcome is unknown (the POST may
// or may not have reached Hermes). It is safe to retry with the same
// Idempotency-Key; a definitive rejection must NOT be wrapped in this.
type admissionUncertain struct{ cause error }

func (e *admissionUncertain) Error() string { return e.cause.Error() }
func (e *admissionUncertain) Unwrap() error { return e.cause }

// isUncertainAdmissionError reports whether an admission error is retryable
// (unknown outcome) rather than a definitive rejection.
func isUncertainAdmissionError(err error) bool {
	var u *admissionUncertain
	return errors.As(err, &u)
}

// getRunStatus fetches the current status of a run.
func (h *HermesExecutor) getRunStatus(runID string) (runStatus, error) {
	req, err := http.NewRequest(http.MethodGet, h.BaseURL+"/v1/runs/"+runID, nil)
	if err != nil {
		return runStatus{}, err
	}
	req.Header.Set("Authorization", "Bearer "+h.APIKey)

	resp, err := h.pollClient().Do(req)
	if err != nil {
		return runStatus{}, fmt.Errorf("hermes run status request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound {
		return runStatus{}, errRunNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return runStatus{}, hermesError(resp.StatusCode, body, "hermes run status")
	}
	var st runStatus
	if err := json.Unmarshal(body, &st); err != nil {
		return runStatus{}, fmt.Errorf("hermes returned a malformed run status")
	}
	return st, nil
}

// pollRun polls a run until it reaches a terminal status and returns the final
// response text (the "output" field). It reports no live activity (see
// pollRunEmit); kept as a thin wrapper for the existing tests and any caller
// that only wants the terminal output.
func (h *HermesExecutor) pollRun(runID string) (string, error) {
	return h.pollRunEmit("", runID)
}

// pollRunEmit polls a run to a terminal status and, when jobID is non-empty and
// an OnActivity sink is wired, reports observed activity as the run progresses.
// A transient poll error is NOT a run failure: the run may still be working
// server-side, so the poll backs off and retries. Only a terminal status (or a
// 404) ends the poll. Activity is emitted only after a successful status read
// (never fabricated from a failed one) and only for non-terminal statuses.
func (h *HermesExecutor) pollRunEmit(jobID, runID string) (string, error) {
	backoff := h.pollInterval()
	const maxBackoff = 30 * time.Second
	lastKind := ""
	var lastActivityAt float64
	lastEmit := time.Time{}
	heartbeat := h.activityHeartbeat()
	for {
		st, err := h.getRunStatus(runID)
		if err != nil {
			if errors.Is(err, errRunNotFound) {
				return "", fmt.Errorf("hermes run %s was not found (already pruned or foreign)", runID)
			}
			// Transient: keep polling with backoff.
			time.Sleep(backoff)
			if backoff < maxBackoff {
				backoff *= 2
			}
			continue
		}
		switch {
		case st.Status == "completed":
			return st.Output, nil
		case terminalRunStatuses[st.Status]:
			msg := st.Error
			if msg == "" {
				msg = "hermes run ended with status " + st.Status
			}
			return "", fmt.Errorf("hermes run %s: %s", st.Status, msg)
		case st.Status == "queued" || st.Status == "running" ||
			st.Status == "waiting_for_approval" || st.Status == "stopping":
			if jobID != "" {
				kind := activityKindForStatus(st)
				now := time.Now()
				if kind != lastKind || st.UpdatedAt != lastActivityAt || now.Sub(lastEmit) >= heartbeat {
					h.emitActivity(jobID, kind, activityTime(st))
					lastKind = kind
					lastActivityAt = st.UpdatedAt
					lastEmit = now
				}
			}
			time.Sleep(h.pollInterval())
			backoff = h.pollInterval()
		default:
			return "", fmt.Errorf("hermes run reported unknown status %q", st.Status)
		}
	}
}

// hermesError builds an error from a non-2xx Hermes response, preferring the
// OpenAI-style error message when present.
func hermesError(status int, body []byte, context string) error {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
		return fmt.Errorf("%s: HTTP %d: %s", context, status, e.Error.Message)
	}
	return fmt.Errorf("%s: HTTP %d", context, status)
}
