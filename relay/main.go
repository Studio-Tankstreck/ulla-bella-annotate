package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/santhosh-tekuri/jsonschema/v5"

	"ullabella-annotate/internal/proto"
	"ullabella-annotate/internal/store"
)

// Request/body limits (Part 15). Jobs get generous headroom so a future
// multi-annotation Job is not rejected, while .ullabella pairing stays tiny.
const (
	maxJobBytes  = 1 << 20 // 1 MiB job payload
	maxPairBytes = 8 << 10 // 8 KiB pairing payload (kept from Task 11)
	maxWSMessage = 1 << 20 // 1 MiB adapter WS message
)

var (
	envelopeSchema *jsonschema.Schema
	jobSchema      *jsonschema.Schema
	resultSchema   *jsonschema.Schema
)

func loadSchema(path string) (*jsonschema.Schema, error) {
	c := jsonschema.NewCompiler()
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	return c.Compile("file://" + filepath.ToSlash(abs))
}

func loadSchemas(dir string) error {
	var err error
	if envelopeSchema, err = loadSchema(filepath.Join(dir, "envelope.schema.json")); err != nil {
		return fmt.Errorf("envelope schema: %w", err)
	}
	if jobSchema, err = loadSchema(filepath.Join(dir, "job.schema.json")); err != nil {
		return fmt.Errorf("job schema: %w", err)
	}
	if resultSchema, err = loadSchema(filepath.Join(dir, "result.schema.json")); err != nil {
		return fmt.Errorf("result schema: %w", err)
	}
	return nil
}

// adapterConn is one authenticated adapter (agent) session. siteIDs is the
// Relay-authoritative list loaded from agent_sites at registration, not a value
// the adapter declares for itself.
type adapterConn struct {
	agentID string
	siteIDs []string
	conn    *websocket.Conn
	mu      sync.Mutex // serializes writes
}

func (c *adapterConn) sendJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return c.conn.WriteJSON(v)
}

func (c *adapterConn) send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return c.conn.WriteMessage(websocket.TextMessage, data)
}

type relay struct {
	mu          sync.Mutex
	conns       map[string]*adapterConn // agentId -> active connection
	store       *store.Store
	pairLimiter *limiter
	jobLimiter  *limiter
}

func newRelay(st *store.Store, pairLimiter, jobLimiter *limiter) *relay {
	return &relay{
		conns:       map[string]*adapterConn{},
		store:       st,
		pairLimiter: pairLimiter,
		jobLimiter:  jobLimiter,
	}
}

// hashPayload returns the SHA-256 hex digest of a raw Job payload, used for
// idempotent dedup (same jobId + same payload must not re-execute).
func hashPayload(payload []byte) string {
	h := sha256.Sum256(payload)
	return hex.EncodeToString(h[:])
}

func (r *relay) addConn(c *adapterConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[c.agentID] = c
}

func (r *relay) dropConn(c *adapterConn) {
	r.mu.Lock()
	if c.agentID != "" {
		delete(r.conns, c.agentID)
		log.Printf("adapter disconnected: agentId=%s", c.agentID)
	}
	r.mu.Unlock()
	_ = c.conn.Close()
}

// findConn returns the active adapter authorized to serve the site, or nil.
// Authorization comes from the persisted agent_sites mapping — not from any
// static registry or adapter self-declaration. It is the pre-etapp-3 fallback
// for jobs that do not name an agent.
func (r *relay) findConn(siteID string) *adapterConn {
	agentIDs, err := r.store.AgentsForSite(siteID)
	if err != nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, aid := range agentIDs {
		if c, ok := r.conns[aid]; ok {
			return c
		}
	}
	return nil
}

// pickConn chooses the adapter for a job. A job that names an agent is routed to
// exactly that agent or not at all — no silent fallback, because the user picked
// which Hermes instance performs the edit. A job without an agentId keeps the
// pre-etapp-3 behaviour (first connected agent authorized for the site).
//
// The agentId is validated against agent_sites here; a client cannot widen its
// own access by naming an agent.
func (r *relay) pickConn(jb proto.Job) (conn *adapterConn, code string, message string) {
	if jb.AgentID != "" {
		allowed, err := r.store.AgentAllowedForSite(jb.SiteID, jb.AgentID)
		if err != nil {
			return nil, "job_store_error", "could not check the agent authorization"
		}
		if !allowed {
			return nil, "agent_not_allowed", "the requested agent is not authorized for this site"
		}
		r.mu.Lock()
		c := r.conns[jb.AgentID]
		r.mu.Unlock()
		if c == nil {
			return nil, "agent_unavailable", "the requested agent is not connected"
		}
		return c, "", ""
	}
	if c := r.findConn(jb.SiteID); c != nil {
		return c, "", ""
	}
	return nil, "agent_unavailable", "no authorized agent is connected for this site"
}

func newMux(r *relay) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", r.handleHealthz)
	mux.HandleFunc("GET /readyz", r.handleReadyz)
	mux.HandleFunc("GET /v1/ws", r.handleAdapterWS)
	mux.HandleFunc("POST /v1/jobs", r.handleCreateJob)
	mux.HandleFunc("GET /v1/jobs/{jobId}", r.handleGetJob)
	mux.HandleFunc("GET /v1/sites/{siteId}/agents", r.handleSiteAgents)
	mux.HandleFunc("POST /v1/pair", r.handlePair)
	return mux
}

func main() {
	if len(os.Args) >= 2 && isCLICommand(os.Args[1]) {
		runCLI(os.Args[1], os.Args[2:])
		return
	}
	serve()
}

func serve() {
	addr := proto.EnvOr("RELAY_ADDR", "127.0.0.1:8787")
	schemaDir := proto.EnvOr("SCHEMA_DIR", "protocol")
	if err := loadSchemas(schemaDir); err != nil {
		log.Fatalf("relay: load schemas: %v", err)
	}
	st, err := store.Open(dbFile())
	if err != nil {
		log.Fatalf("relay: open store: %v", err)
	}
	defer st.Close()
	log.Printf("relay: sqlite store at %s", dbFile())
	log.Printf("relay: private-beta hardening enabled (dev registry removed, agent auth required)")

	// Jobs still in "accepted" (the Adapter never confirmed receipt) can never
	// complete now: mark them interrupted so clients do not poll forever. Jobs
	// in "working" are left for the Adapter, which resumes its durable Hermes
	// runs and re-delivers the result after reconnecting.
	if err := st.InterruptNonTerminal(func(jobID string) string {
		env, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
			JobID:  jobID,
			Status: proto.StatusError,
			Error:  &proto.Error{Code: "relay_restarted", Message: "relay restarted before this job completed"},
		}))
		return string(env)
	}); err != nil {
		log.Printf("relay: warn: interrupt non-terminal jobs: %v", err)
	}

	pairLimiter := parseRateSpec(proto.EnvOr("RATE_LIMIT_PAIR", "5/m"), "5/m")
	jobLimiter := parseRateSpec(proto.EnvOr("RATE_LIMIT_JOBS", "60/m"), "60/m")

	srv := &http.Server{
		Addr:    addr,
		Handler: loggingMiddleware(newMux(newRelay(st, pairLimiter, jobLimiter))),
	}
	log.Printf("relay: listening on %s (deploy behind HTTPS/WSS reverse proxy)", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("relay: listen: %v", err)
	}
}

func (r *relay) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

// handleReadyz reports readiness: DB reachable and migrations applied. It leaks
// no Sites/Devices/Agents/credentials.
func (r *relay) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	if err := r.store.Ready(); err != nil {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready\n"))
}

func (r *relay) handleCreateJob(w http.ResponseWriter, req *http.Request) {
	if !r.jobLimiter.Allow(clientKey(req)) {
		w.Header().Set("Retry-After", "1")
		r.writeError(w, http.StatusTooManyRequests, "", "rate_limited", "too many requests")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, maxJobBytes)
	body, err := io.ReadAll(req.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			r.writeError(w, http.StatusRequestEntityTooLarge, "", "payload_too_large", "job payload exceeds size limit")
			return
		}
		r.writeError(w, http.StatusBadRequest, "", "invalid_message", "cannot read request body")
		return
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_message", "request is not valid JSON")
		return
	}

	// Explicit checks first so failures carry a precise error code, then schema.
	if sv, _ := raw["schemaVersion"].(string); sv != proto.Version {
		r.writeError(w, http.StatusBadRequest, "", "invalid_schema_version", fmt.Sprintf("expected schemaVersion %q", proto.Version))
		return
	}
	if mt, _ := raw["messageType"].(string); mt != proto.MsgTypeJob {
		r.writeError(w, http.StatusBadRequest, "", "invalid_message", fmt.Sprintf("expected messageType %q", proto.MsgTypeJob))
		return
	}
	if err := envelopeSchema.Validate(raw); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_envelope", err.Error())
		return
	}

	var env proto.Envelope
	if err := json.Unmarshal(body, &env); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_message", "cannot decode envelope")
		return
	}
	var payloadRaw map[string]any
	if err := json.Unmarshal(env.Payload, &payloadRaw); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_message", "payload is not a JSON object")
		return
	}
	if err := jobSchema.Validate(payloadRaw); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_job", err.Error())
		return
	}
	var jb proto.Job
	if err := json.Unmarshal(env.Payload, &jb); err != nil {
		r.writeError(w, http.StatusBadRequest, "", "invalid_job", err.Error())
		return
	}

	// Authorization: every Job must carry a valid Device credential. There is
	// no unauthenticated fallback path anymore (Task 06-10 dev registry removed).
	cred := bearerToken(req)
	if cred == "" {
		r.writeError(w, http.StatusUnauthorized, jb.JobID, "invalid_credential", "device credential required")
		return
	}
	dev, ok := r.store.AuthenticateDevice(cred)
	if !ok {
		r.writeError(w, http.StatusUnauthorized, jb.JobID, "invalid_credential", "unknown, invalid, or revoked device credential")
		return
	}
	if dev.DeviceID != jb.DeviceID {
		r.writeError(w, http.StatusUnauthorized, jb.JobID, "device_mismatch", "credential does not match the job deviceId")
		return
	}

	st, ok := r.store.GetSite(jb.SiteID)
	if !ok {
		r.writeError(w, http.StatusNotFound, jb.JobID, "site_not_found", "unknown site")
		return
	}
	if !st.Enabled {
		r.writeError(w, http.StatusForbidden, jb.JobID, "site_disabled", "site is disabled")
		return
	}
	if !contains(dev.Sites, jb.SiteID) {
		r.writeError(w, http.StatusForbidden, jb.JobID, "device_out_of_scope", "device is not allowed to edit this site")
		return
	}
	for _, ann := range jb.Annotations {
		if !sameOrigin(st.Origin, ann.Target.URL) {
			r.writeError(w, http.StatusForbidden, jb.JobID, "url_out_of_origin", fmt.Sprintf("annotation url %q is outside site origin %q", ann.Target.URL, st.Origin))
			return
		}
	}

	// Idempotent dedup (server-side, persistent): the same jobId + identical
	// payload must not start the same execution twice. A different payload under
	// the same jobId is a conflict; a jobId owned by another device is hidden.
	payloadHash := hashPayload(env.Payload)
	if existing, ok := r.store.GetJob(jb.JobID); ok {
		if existing.DeviceID != dev.DeviceID {
			r.writeError(w, http.StatusNotFound, jb.JobID, "job_not_found", "no result for this job")
			return
		}
		if existing.PayloadHash != payloadHash {
			r.writeError(w, http.StatusConflict, jb.JobID, "job_conflict", "jobId was already used with a different payload")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(existing.Result))
		return
	}

	conn, code, message := r.pickConn(jb)
	if conn == nil {
		status := http.StatusServiceUnavailable
		switch code {
		case "agent_not_allowed":
			status = http.StatusForbidden
		case "job_store_error":
			status = http.StatusInternalServerError
		}
		r.writeError(w, status, jb.JobID, code, message)
		return
	}

	// Accept + route. The adapter receives the identical protocol Job envelope.
	acceptedEnv, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{JobID: jb.JobID, Status: proto.StatusAccepted}))
	if err := r.store.CreateJob(jb.JobID, dev.DeviceID, payloadHash, proto.StatusAccepted, string(acceptedEnv)); err != nil {
		if existing, ok := r.store.GetJob(jb.JobID); ok && existing.DeviceID == dev.DeviceID && existing.PayloadHash == payloadHash {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(existing.Result))
			return
		}
		r.writeError(w, http.StatusInternalServerError, jb.JobID, "job_store_error", "could not record job")
		return
	}

	if err := conn.send(body); err != nil {
		log.Printf("relay: route to adapter failed (delivery uncertain): %v", err)
		r.dropConn(conn)
		// A write failure on an established connection is NEVER proof the adapter
		// did not receive the job (the frame may have been delivered before the
		// reset/timeout). Record an explicitly-uncertain terminal result so the
		// job is never silently re-run and never polled forever as "accepted".
		uncertainEnv, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
			JobID:  jb.JobID,
			Status: proto.StatusError,
			Error:  &proto.Error{Code: "delivery_uncertain", Message: "delivery outcome unknown; the edit may or may not have been applied"},
		}))
		_, _ = r.store.SetJobResult(jb.JobID, proto.StatusError, string(uncertainEnv))
		r.writeError(w, http.StatusServiceUnavailable, jb.JobID, "delivery_uncertain", "delivery outcome unknown; the edit may or may not have been applied")
		return
	}

	log.Printf("job accepted: requestId=%s jobId=%s siteId=%s deviceId=%s agentId=%s", requestID(req), jb.JobID, jb.SiteID, dev.DeviceID, conn.agentID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write(acceptedEnv)
}

func (r *relay) handleGetJob(w http.ResponseWriter, req *http.Request) {
	jobID := req.PathValue("jobId")

	// Result reads are bound to the device that created the job. A caller that
	// lacks the owning credential gets a plain 404 (same as a nonexistent job)
	// so jobIds cannot be enumerated by other devices.
	cred := bearerToken(req)
	if cred == "" {
		r.writeError(w, http.StatusUnauthorized, jobID, "invalid_credential", "device credential required")
		return
	}
	dev, ok := r.store.AuthenticateDevice(cred)
	if !ok {
		r.writeError(w, http.StatusUnauthorized, jobID, "invalid_credential", "unknown, invalid, or revoked device credential")
		return
	}

	job, ok := r.store.GetJob(jobID)
	if !ok || job.DeviceID != dev.DeviceID {
		r.writeError(w, http.StatusNotFound, jobID, "job_not_found", "no result for this job")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(job.Result))
}

var upgrader = websocket.Upgrader{
	// The adapter is a server-to-server client (not a browser); it authenticates
	// by credential in the register message. Origin is therefore not a browser
	// trust boundary here.
	CheckOrigin: func(*http.Request) bool { return true },
}

var (
	wsPongWait   = 60 * time.Second
	wsPingPeriod = (wsPongWait * 9) / 10
	wsWriteWait  = 10 * time.Second
)

func (r *relay) handleAdapterWS(w http.ResponseWriter, req *http.Request) {
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("relay: ws upgrade failed: %v", err)
		return
	}
	conn.SetReadLimit(maxWSMessage)
	c := &adapterConn{conn: conn}
	defer r.dropConn(c)

	// Keepalive: the relay pings; a missed pong expires the read deadline and
	// drops an idle/dead adapter connection cleanly.
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	done := make(chan struct{})
	defer close(done)
	go wsPingLoop(conn, done)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		if c.agentID == "" {
			var reg struct {
				Type       string `json:"type"`
				AgentID    string `json:"agentId"`
				Credential string `json:"credential"`
			}
			if err := json.Unmarshal(data, &reg); err != nil || reg.Type != "register" || reg.AgentID == "" || reg.Credential == "" {
				log.Printf("relay: invalid adapter registration: requestId=%s", requestID(req))
				return
			}
			ag, sites, ok := r.store.AuthenticateAgent(reg.AgentID, reg.Credential)
			if !ok {
				// Never log the credential; the agentId alone is safe.
				log.Printf("relay: adapter auth failed: agentId=%s requestId=%s", reg.AgentID, requestID(req))
				return
			}
			c.agentID = ag.AgentID
			c.siteIDs = sites // Relay-authoritative, from agent_sites
			r.addConn(c)
			log.Printf("adapter connected: agentId=%s sites=%v requestId=%s", c.agentID, c.siteIDs, requestID(req))
			_ = c.sendJSON(map[string]any{"type": "registered", "sites": sites})
			continue
		}

		var env proto.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			log.Printf("relay: adapter sent non-envelope message: %v", err)
			continue
		}
		if env.MessageType != proto.MsgTypeResult {
			log.Printf("relay: adapter sent unexpected messageType %q", env.MessageType)
			continue
		}
		var payloadRaw map[string]any
		if err := json.Unmarshal(env.Payload, &payloadRaw); err == nil {
			if err := resultSchema.Validate(payloadRaw); err != nil {
				log.Printf("relay: adapter sent invalid result: %v", err)
				continue
			}
		}
		var res proto.Result
		if err := json.Unmarshal(env.Payload, &res); err == nil && res.JobID != "" {
			if applied, err := r.store.SetJobResult(res.JobID, res.Status, string(data)); err != nil {
				log.Printf("relay: store result failed: jobId=%s: %v", res.JobID, err)
			} else if !applied {
				log.Printf("relay: ignored stale non-terminal result for terminal job: jobId=%s status=%s agentId=%s", res.JobID, res.Status, c.agentID)
			} else {
				log.Printf("result stored: jobId=%s status=%s agentId=%s", res.JobID, res.Status, c.agentID)
			}
		}
	}
}

func wsPingLoop(conn *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(wsPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			// WriteControl scopes the deadline to this control frame only, so a later
			// data write (job forwarding) is never poisoned by an expired deadline.
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteWait)); err != nil {
				return
			}
		}
	}
}

func (r *relay) writeError(w http.ResponseWriter, status int, jobID, code, message string) {
	env, _ := json.Marshal(proto.NewEnvelope(proto.MsgTypeResult, proto.Result{
		JobID:  jobID,
		Status: proto.StatusError,
		Error:  &proto.Error{Code: code, Message: message},
	}))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(env)
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type ctxKey int

const reqIDKey ctxKey = 0

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Hijack and Flush are required so WebSocket upgrades (and streaming responses)
// work through the logging wrapper. The wrapped *http.response implements both;
// these delegate to it instead of hiding the optional interfaces.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("websocket: response does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// loggingMiddleware emits one structured access line per request. It never logs
// headers or bodies, so credentials/tokens cannot leak through it.
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		start := time.Now()
		id := "req_" + randHex(4)
		req = req.WithContext(context.WithValue(req.Context(), reqIDKey, id))
		w.Header().Set("X-Request-Id", id)
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, req)
		log.Printf("http: requestId=%s method=%s path=%s status=%d dur=%s",
			id, req.Method, req.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

func requestID(req *http.Request) string {
	if id, ok := req.Context().Value(reqIDKey).(string); ok {
		return id
	}
	return ""
}

// clientKey returns the rate-limit key for a request. Behind a trusted reverse
// proxy, TRUST_PROXY=1 enables the leftmost X-Forwarded-For value; otherwise
// the socket peer address is used (forwarded headers are never trusted blindly).
func clientKey(req *http.Request) string {
	if os.Getenv("TRUST_PROXY") == "1" {
		if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	return req.RemoteAddr
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "0"
	}
	return hex.EncodeToString(b)
}

// sameOrigin reports whether rawURL's scheme+host equals the site origin.
func sameOrigin(origin, rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	want, err := url.Parse(origin)
	if err != nil || want.Scheme == "" || want.Host == "" {
		return false
	}
	return strings.EqualFold(u.Scheme, want.Scheme) && strings.EqualFold(u.Host, want.Host)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
