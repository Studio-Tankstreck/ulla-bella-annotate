package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"ullabella-annotate/internal/proto"
)

// TestRelayTerminalErrorPropagation is a defense-in-depth regression test: once
// the Relay receives a terminal error Result from an adapter, the polling device
// must see status=error (never a stale accepted) on the very next poll.
func TestRelayTerminalErrorPropagation(t *testing.T) {
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

	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusAccepted || res.Status != proto.StatusAccepted {
		t.Fatalf("expected accepted, got %d %+v", status, res)
	}
	jobID := res.JobID

	// The adapter receives the job.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("adapter did not receive job: %v", err)
	}
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatal(err)
	}

	// The adapter returns a terminal ERROR result.
	out, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
		JobID:  jobID,
		Status: proto.StatusError,
		Error:  &proto.Error{Code: "mcp_unavailable", Message: "MCP endpoint down"},
	}))
	if err := conn.WriteMessage(websocket.TextMessage, out); err != nil {
		t.Fatal(err)
	}

	// The device must see error (not accepted) on the next poll.
	deadline := time.Now().Add(2 * time.Second)
	for {
		code, cur := decodeResult(t, getJobAuth(t, srv.URL, jobID, cred))
		if cur.Status == proto.StatusError {
			if code != http.StatusOK {
				t.Fatalf("error result HTTP = %d, want 200", code)
			}
			if cur.Error == nil || cur.Error.Code != "mcp_unavailable" {
				t.Fatalf("error payload wrong: %+v", cur.Error)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for error; last status=%q", cur.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
