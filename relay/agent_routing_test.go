package main

// Etapp 3: a job that names an agent must reach EXACTLY that agent — no silent
// fallback — and the agent list the browser UI shows must come from an
// authorization-checked source (device scoped, agent_sites scoped).

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
)

// jobBodyAgent builds a job envelope from the fixture with a unique jobId, the
// given device/site and an optional agentId.
func jobBodyAgent(t *testing.T, deviceID, siteID, agentID, jobID string) []byte {
	t.Helper()
	raw := fixtureMap(t, "example-job.json")
	payload := raw["payload"].(map[string]any)
	payload["jobId"] = jobID
	payload["deviceId"] = deviceID
	payload["siteId"] = siteID
	if agentID != "" {
		payload["agentId"] = agentID
	} else {
		delete(payload, "agentId")
	}
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// awaitJob reads one job from an agent connection, or reports that none arrived.
func awaitJob(t *testing.T, agent string, conn interface {
	SetReadDeadline(time.Time) error
	ReadMessage() (int, []byte, error)
}, wait time.Duration) (proto.Job, bool) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	_, data, err := conn.ReadMessage()
	if err != nil {
		return proto.Job{}, false
	}
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("%s: decode envelope: %v", agent, err)
	}
	var jb proto.Job
	if err := json.Unmarshal(env.Payload, &jb); err != nil {
		t.Fatalf("%s: decode job: %v", agent, err)
	}
	return jb, true
}

// routeToChosen connects two agents that are both granted the same site, posts
// ONE job naming `chosen`, and asserts the job reached exactly that agent.
// (A timed-out read kills a gorilla connection, so the "no leak" check is the
// last thing done on each connection — hence one direction per test.)
func routeToChosen(t *testing.T, chosen, other string) {
	t.Helper()
	r, srv := newTestRelay(t)
	_, credA, err := r.store.CreateAgent("agent_a", "Agent A")
	if err != nil {
		t.Fatal(err)
	}
	_, credB, err := r.store.CreateAgent("agent_b", "Agent B")
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{"agent_a", "agent_b"} {
		if err := r.store.GrantSite(a, "site_01j7x9k2m"); err != nil {
			t.Fatal(err)
		}
	}
	connA := dialAgentOK(t, srv, "agent_a", credA)
	defer connA.Close()
	connB := dialAgentOK(t, srv, "agent_b", credB)
	defer connB.Close()
	conns := map[string]interface {
		SetReadDeadline(time.Time) error
		ReadMessage() (int, []byte, error)
	}{"agent_a": connA, "agent_b": connB}

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	jobID := "job_pick_" + chosen
	status, res := decodeResult(t, postJobAuth(t, srv.URL, jobBodyAgent(t, deviceID, "site_01j7x9k2m", chosen, jobID), cred))
	if status != http.StatusAccepted || res.Status != proto.StatusAccepted {
		t.Fatalf("expected accepted, got %d %+v", status, res)
	}

	got, ok := awaitJob(t, chosen, conns[chosen], 2*time.Second)
	if !ok {
		t.Fatalf("the chosen agent %q did not receive the job", chosen)
	}
	if got.JobID != jobID || got.AgentID != chosen {
		t.Fatalf("chosen agent got job %q agentId=%q, want %q/%q", got.JobID, got.AgentID, jobID, chosen)
	}
	if leakedJob, leaked := awaitJob(t, other, conns[other], 300*time.Millisecond); leaked {
		t.Fatalf("the unchosen agent %q must not receive the job (got %q)", other, leakedJob.JobID)
	}
}

func TestJobRoutesToTheChosenAgentB(t *testing.T) {
	routeToChosen(t, "agent_b", "agent_a")
}

func TestJobRoutesToTheChosenAgentA(t *testing.T) {
	routeToChosen(t, "agent_a", "agent_b")
}

func TestJobWithUnallowedAgentIsRejected(t *testing.T) {
	r, srv := newTestRelay(t)
	_, credA, err := r.store.CreateAgent("agent_a", "Agent A")
	if err != nil {
		t.Fatal(err)
	}
	// Only agent_a is granted this site; agent_x exists and is connected.
	if err := r.store.GrantSite("agent_a", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	_, credX, err := r.store.CreateAgent("agent_x", "Agent X")
	if err != nil {
		t.Fatal(err)
	}
	connA := dialAgentOK(t, srv, "agent_a", credA)
	defer connA.Close()
	connX := dialAgentOK(t, srv, "agent_x", credX)
	defer connX.Close()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, jobBodyAgent(t, deviceID, "site_01j7x9k2m", "agent_x", "job_x"), cred),
		http.StatusForbidden, "agent_not_allowed")

	if jb, leaked := awaitJob(t, "agent_x", connX, 250*time.Millisecond); leaked {
		t.Fatalf("an unauthorized agent received a job: %q", jb.JobID)
	}
	if jb, leaked := awaitJob(t, "agent_a", connA, 250*time.Millisecond); leaked {
		t.Fatalf("no job should have been routed at all (agent_a got %q)", jb.JobID)
	}
}

func TestChosenAgentOfflineFailsWithoutFallback(t *testing.T) {
	r, srv := newTestRelay(t)
	_, credA, err := r.store.CreateAgent("agent_a", "Agent A")
	if err != nil {
		t.Fatal(err)
	}
	// agent_b is granted but NOT connected.
	if _, _, err := r.store.CreateAgent("agent_b", "Agent B"); err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{"agent_a", "agent_b"} {
		if err := r.store.GrantSite(a, "site_01j7x9k2m"); err != nil {
			t.Fatal(err)
		}
	}
	connA := dialAgentOK(t, srv, "agent_a", credA)
	defer connA.Close()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	requireError(t, postJobAuth(t, srv.URL, jobBodyAgent(t, deviceID, "site_01j7x9k2m", "agent_b", "job_offline"), cred),
		http.StatusServiceUnavailable, "agent_unavailable")

	if jb, leaked := awaitJob(t, "agent_a", connA, 250*time.Millisecond); leaked {
		t.Fatalf("the job must not fall back to another agent (agent_a got %q)", jb.JobID)
	}
}

func TestJobWithoutAgentIdKeepsTheOldBehaviour(t *testing.T) {
	r, srv := newTestRelay(t)
	_, credA, err := r.store.CreateAgent("agent_a", "Agent A")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.GrantSite("agent_a", "site_01j7x9k2m"); err != nil {
		t.Fatal(err)
	}
	connA := dialAgentOK(t, srv, "agent_a", credA)
	defer connA.Close()

	deviceID, cred := pairDevice(t, r, "site_01j7x9k2m")
	status, res := decodeResult(t, postJobAuth(t, srv.URL, jobBodyAgent(t, deviceID, "site_01j7x9k2m", "", "job_legacy"), cred))
	if status != http.StatusAccepted || res.Status != proto.StatusAccepted {
		t.Fatalf("a job without agentId must still be accepted, got %d %+v", status, res)
	}
	got, ok := awaitJob(t, "agent_a", connA, 2*time.Second)
	if !ok || got.JobID != "job_legacy" {
		t.Fatalf("the authorized connected agent should have received it (ok=%v job=%q)", ok, got.JobID)
	}
}

func TestSiteAgentsEndpointIsScopedAndLive(t *testing.T) {
	r, srv := newTestRelay(t)
	_, credA, err := r.store.CreateAgent("agent_a", "Agent A")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.store.CreateAgent("agent_b", "Agent B"); err != nil { // granted, offline
		t.Fatal(err)
	}
	if _, _, err := r.store.CreateAgent("agent_x", "Agent X"); err != nil { // not granted
		t.Fatal(err)
	}
	for _, a := range []string{"agent_a", "agent_b"} {
		if err := r.store.GrantSite(a, "site_01j7x9k2m"); err != nil {
			t.Fatal(err)
		}
	}
	connA := dialAgentOK(t, srv, "agent_a", credA)
	defer connA.Close()

	getAgents := func(cred string) (*http.Response, siteAgentsResponse, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/v1/sites/site_01j7x9k2m/agents", nil)
		if err != nil {
			t.Fatal(err)
		}
		if cred != "" {
			req.Header.Set("Authorization", "Bearer "+cred)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("get agents: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var ok siteAgentsResponse
		var errShape map[string]any
		if resp.StatusCode == http.StatusOK {
			if err := json.Unmarshal(body, &ok); err != nil {
				t.Fatalf("decode agents: %v (%s)", err, body)
			}
		} else {
			_ = json.Unmarshal(body, &errShape)
		}
		return resp, ok, errShape
	}

	// No credential.
	resp, _, errShape := getAgents("")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if code := errorCode(errShape); code != "invalid_credential" {
		t.Fatalf("error code = %q, want invalid_credential", code)
	}

	// A device that is not paired with this site.
	_, otherCred := pairDevice(t, r, "site_ub_joomla")
	resp, _, errShape = getAgents(otherCred)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for another site's device", resp.StatusCode)
	}
	if code := errorCode(errShape); code != "device_out_of_scope" {
		t.Fatalf("error code = %q, want device_out_of_scope", code)
	}

	// The authorized device sees exactly the granted agents, with live status.
	_, cred := pairDevice(t, r, "site_01j7x9k2m")
	resp, agents, _ := getAgents(cred)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(agents.Agents) != 2 {
		t.Fatalf("expected 2 granted agents, got %d: %+v", len(agents.Agents), agents.Agents)
	}
	byID := map[string]agentView{}
	for _, a := range agents.Agents {
		byID[a.AgentID] = a
	}
	if _, present := byID["agent_x"]; present {
		t.Fatal("an agent that is not granted the site must never be listed")
	}
	if a := byID["agent_a"]; !a.Connected || a.Name != "Agent A" {
		t.Fatalf("agent_a should be listed as connected with its name: %+v", a)
	}
	if b := byID["agent_b"]; b.Connected {
		t.Fatalf("agent_b is not running and must be listed as not connected: %+v", b)
	}
}

func errorCode(m map[string]any) string {
	if m == nil {
		return ""
	}
	if e, ok := m["error"].(map[string]any); ok {
		if c, ok := e["code"].(string); ok {
			return c
		}
	}
	return ""
}
