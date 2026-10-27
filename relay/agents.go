package main

// Agent discovery for the browser UI (sessions etapp 3).
//
// The browser must never guess which agents exist: it asks the Relay, which only
// answers for a device that is authorized for that site, and only lists agents
// that are actually granted to that site (agent_sites). This endpoint is outside
// Protocol V1 — like /v1/pair it returns flat JSON — because it is an operator/
// UI concern, not part of the Job exchange.
//
// Deliberately NOT exposed: agent credentials, Hermes configuration, or any
// agent that is not granted to the site.

import (
	"log"
	"net/http"
)

type agentView struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	// Connected means the adapter for this agent currently holds a websocket to
	// this Relay. It is a live signal, not a stored flag.
	Connected bool `json:"connected"`
}

type siteAgentsResponse struct {
	SiteID string      `json:"siteId"`
	Agents []agentView `json:"agents"`
}

// handleSiteAgents lists the agents the caller may choose for one site.
func (r *relay) handleSiteAgents(w http.ResponseWriter, req *http.Request) {
	siteID := req.PathValue("siteId")
	if siteID == "" {
		writePairError(w, http.StatusBadRequest, "invalid_request", "siteId is required")
		return
	}

	cred := bearerToken(req)
	if cred == "" {
		writePairError(w, http.StatusUnauthorized, "invalid_credential", "device credential required")
		return
	}
	dev, ok := r.store.AuthenticateDevice(cred)
	if !ok {
		writePairError(w, http.StatusUnauthorized, "invalid_credential", "unknown, invalid, or revoked device credential")
		return
	}
	st, ok := r.store.GetSite(siteID)
	if !ok {
		writePairError(w, http.StatusNotFound, "site_not_found", "unknown site")
		return
	}
	if !st.Enabled {
		writePairError(w, http.StatusForbidden, "site_disabled", "site is disabled")
		return
	}
	if !contains(dev.Sites, siteID) {
		writePairError(w, http.StatusForbidden, "device_out_of_scope", "this browser is not authorized for this site")
		return
	}

	agents, err := r.store.AgentsDetailedForSite(siteID)
	if err != nil {
		log.Printf("relay: agents for site failed: siteId=%s requestId=%s err=%v", siteID, requestID(req), err)
		writePairError(w, http.StatusInternalServerError, "internal_error", "could not list agents")
		return
	}

	out := siteAgentsResponse{SiteID: siteID, Agents: make([]agentView, 0, len(agents))}
	r.mu.Lock()
	for _, a := range agents {
		out.Agents = append(out.Agents, agentView{
			AgentID:   a.AgentID,
			Name:      a.DisplayName,
			Connected: r.conns[a.AgentID] != nil,
		})
	}
	r.mu.Unlock()

	// Safe identities only: agent ids are operator-chosen, never credentials.
	log.Printf("agents listed: siteId=%s deviceId=%s count=%d requestId=%s", siteID, dev.DeviceID, len(out.Agents), requestID(req))
	writeJSON(w, http.StatusOK, out)
}
