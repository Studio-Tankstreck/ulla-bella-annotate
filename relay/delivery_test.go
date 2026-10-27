package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"ullabella-annotate/internal/proto"
)

// TestJobSendableAfterExpiredWriteDeadline reproduces the incident's root cause:
// a write deadline left on the shared WebSocket (previously by wsPingLoop) must
// not make a later job forward fail. The fix resets the deadline in send/sendJSON.
func TestJobSendableAfterExpiredWriteDeadline(t *testing.T) {
	r, srv := newTestRelay(t)
	_, agentCred, err := r.store.CreateAgent("agent_test", "Test Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.GrantSite("agent_test", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	conn := dialAgentOK(t, srv, "agent_test", agentCred)
	defer conn.Close()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")

	// Simulate the stale write deadline the old ping loop left behind.
	r.mu.Lock()
	ac := r.conns["agent_test"]
	r.mu.Unlock()
	if ac == nil {
		t.Fatal("agent connection not registered")
	}
	if err := ac.conn.SetWriteDeadline(time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}

	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusAccepted || res.Status != proto.StatusAccepted {
		t.Fatalf("expected accepted, got %d %+v", status, res)
	}

	// The job must still reach the adapter despite the previously-expired deadline.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("adapter did not receive job after expired deadline: %v", err)
	}
}

// TestWriteFailureDeliveryUncertain: when a write to an established adapter
// connection fails with a connection error (broken pipe / reset — not a
// timeout), the outcome is still UNKNOWN: the frame may have been delivered
// before the reset. The job must be marked an explicitly-uncertain terminal
// error and kept — never deleted, never silently re-run.
func TestWriteFailureDeliveryUncertain(t *testing.T) {
	r, srv := newTestRelay(t)
	_, agentCred, err := r.store.CreateAgent("agent_test", "Test Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.GrantSite("agent_test", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	_ = dialAgentOK(t, srv, "agent_test", agentCred)

	// Inject a dead connection (dial + close) so the relay's registered conn is
	// already unusable, but still present in the map (the read loop hasn't reaped it).
	dead, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = dead.Close()
	r.mu.Lock()
	r.conns["agent_test"] = &adapterConn{agentID: "agent_test", siteIDs: []string{"site_01j7x9k2m"}, conn: dead}
	r.mu.Unlock()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")

	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "delivery_uncertain" {
		t.Fatalf("result = %+v, want error delivery_uncertain", res)
	}
	// The job must be KEPT (terminal uncertain), never deleted.
	j, ok := r.store.GetJob(res.JobID)
	if !ok || j.Status != proto.StatusError {
		t.Fatalf("job %s not kept as terminal: %+v", res.JobID, j)
	}
}

// TestUncertainDeliveryMarksTerminal: when the write times out (delivery outcome
// unknown), the job is marked an explicitly-uncertain terminal error — never a
// stuck "accepted", and never silently re-run by a retry.
func TestUncertainDeliveryMarksTerminal(t *testing.T) {
	r, srv := newTestRelay(t)
	_, agentCred, err := r.store.CreateAgent("agent_test", "Test Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.GrantSite("agent_test", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	conn := dialAgentOK(t, srv, "agent_test", agentCred)
	defer conn.Close()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")

	// Make data writes fail immediately with a write-deadline timeout.
	old := wsWriteWait
	wsWriteWait = -time.Second
	t.Cleanup(func() { wsWriteWait = old })

	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "delivery_uncertain" {
		t.Fatalf("result = %+v, want error delivery_uncertain", res)
	}
	jobID := res.JobID
	j, ok := r.store.GetJob(jobID)
	if !ok || j.Status != proto.StatusError {
		t.Fatalf("job %s not marked terminal: %+v", jobID, j)
	}

	// A retry (same jobId + payload) must hit the dedup path and return the same
	// uncertain result — it must NOT re-run and must NOT get stuck in "accepted".
	status2, res2 := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status2 != http.StatusOK {
		t.Fatalf("retry status = %d, want 200 (idempotent dedup)", status2)
	}
	if res2.Status != proto.StatusError || res2.Error == nil || res2.Error.Code != "delivery_uncertain" {
		t.Fatalf("retry result = %+v, want the persisted uncertain error", res2)
	}
}
