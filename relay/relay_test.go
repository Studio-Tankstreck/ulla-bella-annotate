package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"ullabella-annotate/internal/proto"
	"ullabella-annotate/internal/store"
)

func TestMain(m *testing.M) {
	if err := loadSchemas(filepath.Join("..", "protocol")); err != nil {
		_, _ = os.Stderr.WriteString("cannot load schemas: " + err.Error() + "\n")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// newTestStore opens a temp SQLite DB and seeds the two development sites the
// fixtures reference (origin values match protocol/fixtures).
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "ulla-bella.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct{ id, origin, name string }{
		{"site_01j7x9k2m", "https://example.test", "Example Test"},
		{"site_ub_joomla", "https://joomla.example.test", "Ulla-Bella Joomla"},
	} {
		if _, err := st.CreateSite(s.id, s.origin, s.name); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func newTestRelay(t *testing.T) (*relay, *httptest.Server) {
	t.Helper()
	st := newTestStore(t)
	r := newRelay(st, newLimiter(1000, 1000), newLimiter(1000, 1000))
	srv := httptest.NewServer(loggingMiddleware(newMux(r)))
	t.Cleanup(srv.Close)
	return r, srv
}

func newTestRelayWithLimiters(t *testing.T, pair, job *limiter) (*relay, *httptest.Server) {
	t.Helper()
	st := newTestStore(t)
	r := newRelay(st, pair, job)
	srv := httptest.NewServer(loggingMiddleware(newMux(r)))
	t.Cleanup(srv.Close)
	return r, srv
}

func postJob(t *testing.T, baseURL string, body []byte) *http.Response {
	t.Helper()
	resp, err := http.Post(baseURL+"/v1/jobs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	return resp
}

func postJobAuth(t *testing.T, baseURL string, body []byte, cred string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/jobs", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cred != "" {
		req.Header.Set("Authorization", "Bearer "+cred)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	return resp
}

func getJobAuth(t *testing.T, baseURL, jobID, cred string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/v1/jobs/"+jobID, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if cred != "" {
		req.Header.Set("Authorization", "Bearer "+cred)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	return resp
}

func httpPost(t *testing.T, url string, body []byte) *http.Response {
	t.Helper()
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	return resp
}

func postPair(t *testing.T, baseURL, invite string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"invite": invite})
	return httpPost(t, baseURL+"/v1/pair", body)
}

func decodePair(t *testing.T, resp *http.Response) (int, map[string]any) {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp.StatusCode, m
}

// pairDevice mints + redeems an invite for siteID, returning the new device's
// id and raw credential (raw credential exists only here, matching production).
func pairDevice(t *testing.T, r *relay, siteID string) (deviceID, credential string) {
	t.Helper()
	_, token, err := r.store.CreateInvite(siteID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	dev, cred, _, err := r.store.RedeemInvite(token)
	if err != nil {
		t.Fatal(err)
	}
	return dev.DeviceID, cred
}

func decodeResult(t *testing.T, resp *http.Response) (int, proto.Result) {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var env proto.Envelope
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("response is not an envelope: %v (body=%s)", err, b)
	}
	var res proto.Result
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		t.Fatalf("payload is not a result: %v (body=%s)", err, b)
	}
	return resp.StatusCode, res
}

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "protocol", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func fixtureMap(t *testing.T, name string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(loadFixture(t, name), &m); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return m
}

// jobBody loads a fixture and overrides deviceId/siteId/target URL, then
// re-marshals. Empty strings leave the field unchanged.
func jobBodyURL(t *testing.T, name, deviceID, siteID, targetURL string) []byte {
	t.Helper()
	raw := fixtureMap(t, name)
	payload := raw["payload"].(map[string]any)
	if deviceID != "" {
		payload["deviceId"] = deviceID
	}
	if siteID != "" {
		payload["siteId"] = siteID
	}
	if targetURL != "" {
		payload["annotations"].([]any)[0].(map[string]any)["target"].(map[string]any)["url"] = targetURL
	}
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func jobBody(t *testing.T, name, deviceID, siteID string) []byte {
	return jobBodyURL(t, name, deviceID, siteID, "")
}

func requireError(t *testing.T, resp *http.Response, wantStatus int, wantCode string) {
	t.Helper()
	code, res := decodeResult(t, resp)
	if code != wantStatus {
		t.Fatalf("HTTP status = %d, want %d", code, wantStatus)
	}
	if res.Status != proto.StatusError {
		t.Fatalf("status = %q, want error", res.Status)
	}
	if res.Error == nil || res.Error.Code != wantCode {
		t.Fatalf("error = %+v, want code %q", res.Error, wantCode)
	}
}

// ---------------------------------------------------------------------------
// Protocol / schema
// ---------------------------------------------------------------------------

func TestFixturesValidate(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal(loadFixture(t, "example-job.json"), &raw); err != nil {
		t.Fatal(err)
	}
	if err := envelopeSchema.Validate(raw); err != nil {
		t.Fatalf("example job envelope invalid: %v", err)
	}
	var env proto.Envelope
	_ = json.Unmarshal(loadFixture(t, "example-job.json"), &env)
	var payload map[string]any
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if err := jobSchema.Validate(payload); err != nil {
		t.Fatalf("example job payload invalid: %v", err)
	}

	if err := json.Unmarshal(loadFixture(t, "example-done-result.json"), &raw); err != nil {
		t.Fatal(err)
	}
	if err := envelopeSchema.Validate(raw); err != nil {
		t.Fatalf("example result envelope invalid: %v", err)
	}
	var resultEnv proto.Envelope
	_ = json.Unmarshal(loadFixture(t, "example-done-result.json"), &resultEnv)
	var resultPayload map[string]any
	if err := json.Unmarshal(resultEnv.Payload, &resultPayload); err != nil {
		t.Fatal(err)
	}
	if err := resultSchema.Validate(resultPayload); err != nil {
		t.Fatalf("example result payload invalid: %v", err)
	}
}

func TestInvalidSchemaVersion(t *testing.T) {
	_, srv := newTestRelay(t)
	raw := fixtureMap(t, "example-job.json")
	raw["schemaVersion"] = "999"
	body, _ := json.Marshal(raw)
	requireError(t, postJob(t, srv.URL, body), http.StatusBadRequest, "invalid_schema_version")
}

func TestInvalidDoneResult(t *testing.T) {
	done := map[string]any{"jobId": "job_x", "status": "done", "summary": "x"}
	if err := resultSchema.Validate(done); err == nil {
		t.Fatal("done without verification should be rejected")
	}
	done["verification"] = map[string]any{"status": "failed"}
	if err := resultSchema.Validate(done); err == nil {
		t.Fatal("done with verification.status=failed should be rejected")
	}
	done["verification"] = map[string]any{"status": "passed", "summary": "x"}
	if err := resultSchema.Validate(done); err != nil {
		t.Fatalf("valid done result rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Device authorization (Part 12: invalid credential, wrong device, wrong site,
// URL outside origin).
// ---------------------------------------------------------------------------

func TestJobInvalidCredential(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, _ := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, body, "ubd_wrong"), http.StatusUnauthorized, "invalid_credential")
}

func TestJobMissingCredential(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, _ := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	requireError(t, postJob(t, srv.URL, body), http.StatusUnauthorized, "invalid_credential")
}

func TestJobCredentialDeviceMismatch(t *testing.T) {
	r, srv := newTestRelay(t)
	_, cred := pairDevice(t, r, "site_01j7x9k2m")
	// The credential belongs to the paired device, but the payload claims a
	// different deviceId (the fixture's static dev id).
	requireError(t, postJobAuth(t, srv.URL, loadFixture(t, "example-job.json"), cred), http.StatusUnauthorized, "device_mismatch")
}

func TestDeviceCredentialScopedToSite(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_ub_joomla")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusForbidden, "device_out_of_scope")
}

func TestURLOutsideOrigin(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBodyURL(t, "example-job.json", deviceID, "site_01j7x9k2m", "https://evil.test/services")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusForbidden, "url_out_of_origin")
}

func TestAgentUnavailable(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusServiceUnavailable, "agent_unavailable")
}

func TestDeviceRevokedCannotSubmit(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	if err := r.store.RevokeDevice(deviceID); err != nil {
		t.Fatal(err)
	}
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusUnauthorized, "invalid_credential")
}

func TestSiteDisabledBlocksJob(t *testing.T) {
	r, srv := newTestRelay(t)
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	if err := r.store.SetSiteEnabled("site_01j7x9k2m", false); err != nil {
		t.Fatal(err)
	}
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusForbidden, "site_disabled")
}

// ---------------------------------------------------------------------------
// Invite -> Device pairing (Task 11 contract preserved).
// ---------------------------------------------------------------------------

func TestPairEndpointRedeemsAndCreatesDevice(t *testing.T) {
	r, srv := newTestRelay(t)
	_, token, err := r.store.CreateInvite("site_01j7x9k2m", time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	status, body := decodePair(t, postPair(t, srv.URL, token))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["deviceId"] == nil || body["siteId"] != "site_01j7x9k2m" || body["origin"] == nil || body["displayName"] == nil || body["deviceCredential"] == nil {
		t.Fatalf("pair response missing fields: %v", body)
	}
	if cred, _ := body["deviceCredential"].(string); cred == "" {
		t.Fatal("empty credential")
	}

	status2, body2 := decodePair(t, postPair(t, srv.URL, token))
	if status2 != http.StatusConflict {
		t.Fatalf("reuse status = %d", status2)
	}
	if code, _ := body2["error"].(map[string]any)["code"].(string); code != "invite_already_used" {
		t.Fatalf("reuse error code = %q", code)
	}
}

func TestPairInvalidToken(t *testing.T) {
	_, srv := newTestRelay(t)
	status, body := decodePair(t, postPair(t, srv.URL, "ub_nope"))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if code, _ := body["error"].(map[string]any)["code"].(string); code != "invite_not_found" {
		t.Fatalf("error code = %q", code)
	}
}

func TestPairExpiredInvite(t *testing.T) {
	r, srv := newTestRelay(t)
	_, token, err := r.store.CreateInvite("site_01j7x9k2m", -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	status, body := decodePair(t, postPair(t, srv.URL, token))
	if status != http.StatusGone {
		t.Fatalf("status = %d", status)
	}
	if code, _ := body["error"].(map[string]any)["code"].(string); code != "invite_expired" {
		t.Fatalf("error code = %q", code)
	}
}

func TestPairMalformedBody(t *testing.T) {
	_, srv := newTestRelay(t)
	body, _ := json.Marshal(map[string]string{})
	status, resp := decodePair(t, httpPost(t, srv.URL+"/v1/pair", body))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if code, _ := resp["error"].(map[string]any)["code"].(string); code != "invalid_request" {
		t.Fatalf("error code = %q", code)
	}
}

func TestSiteDisabledBlocksPairing(t *testing.T) {
	r, srv := newTestRelay(t)
	_, token, _ := r.store.CreateInvite("site_01j7x9k2m", time.Minute)
	if err := r.store.SetSiteEnabled("site_01j7x9k2m", false); err != nil {
		t.Fatal(err)
	}
	status, body := decodePair(t, postPair(t, srv.URL, token))
	if status != http.StatusForbidden {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if code, _ := body["error"].(map[string]any)["code"].(string); code != "site_disabled" {
		t.Fatalf("error code = %q", code)
	}
}

// ---------------------------------------------------------------------------
// Result authorization (Part 13) — cross-device reads must fail.
// ---------------------------------------------------------------------------

func TestCrossDeviceResultAccess(t *testing.T) {
	r, srv := newTestRelay(t)
	devA, credA := pairDevice(t, r, "site_01j7x9k2m")
	_, credB := pairDevice(t, r, "site_01j7x9k2m")

	jobID := "job_owned_by_a"
	resEnv := proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
		JobID:        jobID,
		Status:       proto.StatusDone,
		Summary:      "x",
		Verification: &proto.Verification{Status: "passed"},
	})
	b, _ := json.Marshal(resEnv)
	if err := r.store.CreateJob(jobID, devA, "test-hash", proto.StatusDone, string(b)); err != nil {
		t.Fatal(err)
	}

	// Owner reads it.
	status, res := decodeResult(t, getJobAuth(t, srv.URL, jobID, credA))
	if status != http.StatusOK || res.Status != proto.StatusDone {
		t.Fatalf("owner read: status=%d res=%+v", status, res)
	}
	// Another device gets 404 (indistinguishable from nonexistent).
	requireError(t, getJobAuth(t, srv.URL, jobID, credB), http.StatusNotFound, "job_not_found")
	// Unknown jobId -> 404.
	requireError(t, getJobAuth(t, srv.URL, "job_nope", credA), http.StatusNotFound, "job_not_found")
}

// ---------------------------------------------------------------------------
// Agent authentication + Relay-authoritative routing (Parts 9, 10).
// ---------------------------------------------------------------------------

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws"
}

// dialAgentOK dials, registers, and returns a connected, authenticated adapter.
func dialAgentOK(t *testing.T, srv *httptest.Server, agentID, cred string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "register", "agentId": agentID, "credential": cred}); err != nil {
		t.Fatal(err)
	}
	var ack struct {
		Type  string   `json:"type"`
		Sites []string `json:"sites"`
	}
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatalf("registration rejected: %v", err)
	}
	if ack.Type != "registered" {
		t.Fatalf("ack type = %q", ack.Type)
	}
	return conn
}

func TestAgentAuthRejected(t *testing.T) {
	r, srv := newTestRelay(t)
	_, goodCred, err := r.store.CreateAgent("agent_test", "Test Agent")
	if err != nil {
		t.Fatal(err)
	}
	_ = goodCred

	conn, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "register", "agentId": "agent_test", "credential": "uba_wrong"}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var ack struct {
		Type string `json:"type"`
	}
	if err := conn.ReadJSON(&ack); err == nil && ack.Type == "registered" {
		t.Fatal("wrong agent credential must not register")
	}
}

func TestAgentCannotClaimUnauthorizedSite(t *testing.T) {
	r, srv := newTestRelay(t)
	_, agentCred, err := r.store.CreateAgent("agent_test", "Test Agent")
	if err != nil {
		t.Fatal(err)
	}
	// Granted ONLY site_01j7x9k2m — not site_ub_joomla.
	if err := r.store.GrantSite("agent_test", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	conn := dialAgentOK(t, srv, "agent_test", agentCred)
	defer conn.Close()

	deviceID, cred := pairDevice(t, r, "site_ub_joomla")
	body := jobBodyURL(t, "example-job.json", deviceID, "site_ub_joomla", "https://joomla.example.test/")
	// The agent is connected but not authorized for site_ub_joomla -> no route.
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusServiceUnavailable, "agent_unavailable")
}

func TestJobRoutedToAgent(t *testing.T) {
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
	var jb proto.Job
	if err := json.Unmarshal(env.Payload, &jb); err != nil {
		t.Fatal(err)
	}
	if jb.JobID != jobID {
		t.Fatalf("jobId mismatch: %q != %q", jb.JobID, jobID)
	}

	// The adapter returns a verified done result.
	out, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
		JobID:        jobID,
		Status:       proto.StatusDone,
		Summary:      "changed",
		Verification: &proto.Verification{Status: "passed", Summary: "ok"},
	}))
	if err := conn.WriteMessage(websocket.TextMessage, out); err != nil {
		t.Fatal(err)
	}

	// The device retrieves the result.
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, cur := decodeResult(t, getJobAuth(t, srv.URL, jobID, cred))
		if cur.Status == proto.StatusDone {
			if cur.Verification == nil || cur.Verification.Status != "passed" {
				t.Fatal("done result missing verification")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for done; last=%+v", cur)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// Rate limits + request limits + health (Parts 14, 15, 18).
// ---------------------------------------------------------------------------

func TestRateLimitPair(t *testing.T) {
	r, srv := newTestRelayWithLimiters(t, newLimiter(0.5, 1), newLimiter(1000, 1000))
	_, token, _ := r.store.CreateInvite("site_01j7x9k2m", time.Minute)

	status, _ := decodePair(t, postPair(t, srv.URL, token))
	if status != http.StatusOK {
		t.Fatalf("first pair status = %d", status)
	}
	status2, body2 := decodePair(t, postPair(t, srv.URL, token))
	if status2 != http.StatusTooManyRequests {
		t.Fatalf("second pair status = %d, want 429", status2)
	}
	if code, _ := body2["error"].(map[string]any)["code"].(string); code != "rate_limited" {
		t.Fatalf("error code = %q", code)
	}
}

func TestRateLimitJobs(t *testing.T) {
	r, srv := newTestRelayWithLimiters(t, newLimiter(1000, 1000), newLimiter(0.5, 1))
	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	body := jobBody(t, "example-job.json", deviceID, "site_01j7x9k2m")

	// First request consumes the bucket (and lands on agent_unavailable).
	resp := postJobAuth(t, srv.URL, body, cred)
	resp.Body.Close()
	requireError(t, postJobAuth(t, srv.URL, body, cred), http.StatusTooManyRequests, "rate_limited")
}

func TestRequestBodyTooLarge(t *testing.T) {
	_, srv := newTestRelay(t)
	body := []byte(`{"x":"` + strings.Repeat("a", maxJobBytes+1024) + `"}`)
	requireError(t, postJobAuth(t, srv.URL, body, ""), http.StatusRequestEntityTooLarge, "payload_too_large")
}

func TestHealthAndReadiness(t *testing.T) {
	_, srv := newTestRelay(t)
	for _, p := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s = %d", p, resp.StatusCode)
		}
		_ = resp.Body.Close()
	}
}

// ---------------------------------------------------------------------------
// Logging redaction (Part 19) — tokens/credentials must never hit logs.
// ---------------------------------------------------------------------------

func TestLogRedaction(t *testing.T) {
	r, srv := newTestRelay(t)
	_, token, _ := r.store.CreateInvite("site_01j7x9k2m", time.Minute)

	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	_, body := decodePair(t, postPair(t, srv.URL, token))
	cred, _ := body["deviceCredential"].(string)

	out := buf.String()
	if strings.Contains(out, token) {
		t.Fatal("raw invite token leaked into logs")
	}
	if cred != "" && strings.Contains(out, cred) {
		t.Fatal("device credential leaked into logs")
	}
	if strings.Contains(out, "Authorization") {
		t.Fatal("authorization header leaked into logs")
	}
	// The safe identifiers should be present.
	if !strings.Contains(out, "deviceId=") {
		t.Fatal("expected deviceId to be logged (safe identifier missing)")
	}
}
