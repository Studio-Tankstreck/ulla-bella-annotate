package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"ullabella-annotate/internal/proto"
)

// slowExecutor blocks for a fixed duration before returning done, simulating a
// long-running Hermes/MCP edit (Task 13's MCP-down case took ~69s).
type slowExecutor struct{ d time.Duration }

func (s slowExecutor) Execute(SiteContext) Outcome {
	time.Sleep(s.d)
	return doneOutcome("slow but finished")
}

var testUpgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// fakeRelayKeepalive mirrors the Relay's wsPingLoop + read-deadline keepalive
// (relay/main.go) but with short, test-friendly durations. It sends one Job,
// pings periodically, and drops the connection if no pong arrives within
// pongWait — exactly the behavior that lost Task 13's terminal error result.
func fakeRelayKeepalive(t *testing.T, pingPeriod, pongWait time.Duration) (string, <-chan proto.Result) {
	t.Helper()
	resultCh := make(chan proto.Result, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		// Registration handshake.
		var reg struct {
			Type       string `json:"type"`
			AgentID    string `json:"agentId"`
			Credential string `json:"credential"`
		}
		if err := conn.ReadJSON(&reg); err != nil {
			t.Errorf("registration: %v", err)
			return
		}
		if err := conn.WriteJSON(map[string]any{"type": "registered", "sites": []string{"site_01j7x9k2m"}}); err != nil {
			t.Errorf("ack: %v", err)
			return
		}

		// Send one Job.
		jobBytes, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeJob, canonicalJob()))
		if err := conn.WriteMessage(websocket.TextMessage, jobBytes); err != nil {
			t.Errorf("job: %v", err)
			return
		}

		// Keepalive, mirroring the Relay.
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(pongWait))
		})
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			ticker := time.NewTicker(pingPeriod)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
					if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
						return
					}
				}
			}
		}()

		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("relay dropped connection before receiving result: %v", err)
				return
			}
			var env proto.Envelope
			if err := json.Unmarshal(data, &env); err != nil {
				t.Errorf("envelope: %v", err)
				return
			}
			var res proto.Result
			if err := json.Unmarshal(env.Payload, &res); err != nil {
				t.Errorf("result: %v", err)
				return
			}
			// The Adapter now sends a "working" delivery ack before the terminal
			// result; skip it and any other non-terminal status.
			if res.Status == proto.StatusDone || res.Status == proto.StatusError {
				resultCh <- res
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	return "ws" + srv.URL[len("http"):] + "/v1/ws", resultCh
}

// TestAdapterDeliversResultForLongJob reproduces Task 13's lost-result bug: the
// Adapter must keep answering the Relay's keepalive pings while a Job executes,
// or the Relay drops the connection and the terminal result never arrives. The
// poller then sees the stale accepted status until its own timeout.
func TestAdapterDeliversResultForLongJob(t *testing.T) {
	const (
		pingPeriod = 200 * time.Millisecond
		pongWait   = 500 * time.Millisecond
		jobDelay   = 1500 * time.Millisecond // > pongWait
	)

	wsURL, resultCh := fakeRelayKeepalive(t, pingPeriod, pongWait)

	go func() {
		_, _ = run(wsURL, "agent_test", "ub_credential", slowExecutor{d: jobDelay}, devSites(), nil, nil)
	}()

	select {
	case res := <-resultCh:
		if res.Status != proto.StatusDone {
			t.Fatalf("result status = %q, want done", res.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for result — adapter failed to deliver a terminal result for a long job")
	}
}
