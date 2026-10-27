package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
	"ullabella-annotate/internal/store"
)

// setupAcceptedJob connects an agent, pairs a device, and POSTs a job so it is
// accepted and recorded. Returns the relay, server, device id + credential, the
// canonical job body, and the accepted jobId.
func setupAcceptedJob(t *testing.T) (*relay, *httptest.Server, string, string, []byte, string) {
	t.Helper()
	r, srv := newTestRelay(t)
	_, agentCred, err := r.store.CreateAgent("agent_dedup", "Dedup Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.GrantSite("agent_dedup", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	conn := dialAgentOK(t, srv, "agent_dedup", agentCred)
	t.Cleanup(func() { _ = conn.Close() })

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusAccepted || res.Status != proto.StatusAccepted {
		t.Fatalf("expected accepted, got %d %+v", status, res)
	}
	return r, srv, deviceID, cred, body, res.JobID
}

// jobBodyMutated builds a job body for the given device with an explicit jobId
// and instruction (for the conflict/cross-device cases).
func jobBodyMutated(t *testing.T, deviceID, jobID, instruction string) []byte {
	t.Helper()
	raw := fixtureMap(t, "example-job.json")
	payload := raw["payload"].(map[string]any)
	payload["deviceId"] = deviceID
	payload["jobId"] = jobID
	payload["annotations"].([]any)[0].(map[string]any)["instruction"] = instruction
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestJobDedupSamePayload(t *testing.T) {
	_, srv, _, cred, body, jobID := setupAcceptedJob(t)

	// Identical re-submit must be idempotent: 200, same job, no re-execution.
	status, res := decodeResult(t, postJobAuth(t, srv.URL, body, cred))
	if status != http.StatusOK {
		t.Fatalf("idempotent re-submit should be 200, got %d", status)
	}
	if res.JobID != jobID || res.Status != proto.StatusAccepted {
		t.Fatalf("idempotent re-submit returned %+v", res)
	}
}

func TestJobDedupDifferentPayload(t *testing.T) {
	_, srv, deviceID, cred, _, jobID := setupAcceptedJob(t)

	body := jobBodyMutated(t, deviceID, jobID, "a totally different change")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusConflict, "job_conflict")
}

func TestJobDedupCrossDeviceHidden(t *testing.T) {
	r, srv, _, _, _, jobID := setupAcceptedJob(t)

	otherDeviceID, otherCred := pairDevice(t, r, "site_01j7x9k2m")
	// Same jobId but owned by a different device -> 404 (hidden, not leaked).
	body := jobBodyMutated(t, otherDeviceID, jobID, "change this heading")
	requireError(t, postJobAuth(t, srv.URL, body, otherCred), http.StatusNotFound, "job_not_found")
}

func TestJobDedupPersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "ulla-bella.db")

	st1, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st1.CreateSite("site_01j7x9k2m", "https://example.test", "Example"); err != nil {
		t.Fatal(err)
	}
	if _, err := st1.CreateSite("site_ub_joomla", "https://joomla.example.test", "Joomla"); err != nil {
		t.Fatal(err)
	}
	_, agentCred, err := st1.CreateAgent("agent_persist", "Persist Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := st1.GrantSite("agent_persist", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	_, token, err := st1.CreateInvite("site_01j7x9k2m", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	dev, deviceCred, _, err := st1.RedeemInvite(token)
	if err != nil {
		t.Fatal(err)
	}

	r1 := newRelay(st1, newLimiter(1000, 1000), newLimiter(1000, 1000))
	srv1 := httptest.NewServer(loggingMiddleware(newMux(r1)))
	conn := dialAgentOK(t, srv1, "agent_persist", agentCred)
	body := jobBody(t, "example-job.json", dev.DeviceID, "site_01j7x9k2m")
	status, res := decodeResult(t, postJobAuth(t, srv1.URL, body, deviceCred))
	if status != http.StatusAccepted {
		t.Fatalf("expected accepted, got %d", status)
	}
	_ = conn.Close()
	srv1.Close()
	_ = st1.Close() // simulate restart

	st2, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	r2 := newRelay(st2, newLimiter(1000, 1000), newLimiter(1000, 1000))
	srv2 := httptest.NewServer(loggingMiddleware(newMux(r2)))
	defer srv2.Close()

	// Same body re-POSTed to the restarted relay: still deduped (persistent).
	status2, res2 := decodeResult(t, postJobAuth(t, srv2.URL, body, deviceCred))
	if status2 != http.StatusOK || res2.JobID != res.JobID {
		t.Fatalf("dedup did not survive restart: %d %+v", status2, res2)
	}
}

func TestInterruptNonTerminal(t *testing.T) {
	r, _ := newTestRelay(t)
	if err := r.store.CreateJob("j_accepted", "d1", "h1", proto.StatusAccepted, `{"x":1}`); err != nil {
		t.Fatal(err)
	}
	if err := r.store.CreateJob("j_working", "d1", "h3", proto.StatusWorking, `{"x":3}`); err != nil {
		t.Fatal(err)
	}
	if err := r.store.CreateJob("j_done", "d1", "h2", proto.StatusDone, `{"x":2}`); err != nil {
		t.Fatal(err)
	}
	if err := r.store.InterruptNonTerminal(func(id string) string { return "interrupted:" + id }); err != nil {
		t.Fatal(err)
	}
	j1, _ := r.store.GetJob("j_accepted")
	if j1.Status != proto.StatusError || j1.Result != "interrupted:j_accepted" {
		t.Fatalf("accepted job not interrupted: %+v", j1)
	}
	// A "working" job must be LEFT ALONE: with durable runs the Adapter resumes
	// it and re-delivers the result, so interrupting it here would falsely mark
	// a recoverable run as failed.
	j3, _ := r.store.GetJob("j_working")
	if j3.Status != proto.StatusWorking {
		t.Fatalf("working job must not be interrupted: %+v", j3)
	}
	j2, _ := r.store.GetJob("j_done")
	if j2.Status != proto.StatusDone {
		t.Fatalf("terminal job must not be interrupted: %+v", j2)
	}
}
