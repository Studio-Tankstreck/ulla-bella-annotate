// Package store is the Relay's SQLite persistence layer. It is the single
// authoritative home for Sites, Agents, Invites, and Devices, and it replaces
// the Task 11 JSON state file (internal/pairing).
//
// Security invariants enforced here:
//
//   - Invite tokens, Device credentials, and Agent credentials are NEVER stored
//     in plaintext. Only their SHA-256 digests are written to disk.
//   - A raw Invite token exists only when minted and inside the exported
//     .ullabella file. A raw Device/Agent credential is returned to the caller
//     exactly once (at redemption / creation / rotation) and never logged.
//   - Site routing is authoritative here: an Agent may only serve Sites that an
//     operator granted it via agent_sites; a Device may only edit Sites it was
//     paired to via device_sites.
//
// Pairing remains plain REST outside Protocol V1; error codes stay stable and
// machine-readable.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver; no CGO
)

// Stable error codes surfaced to the browser/operator. These are machine
// readable and must not change between releases.
const (
	ErrInviteNotFound = "invite_not_found"
	ErrInviteExpired  = "invite_expired"
	ErrInviteUsed     = "invite_already_used"
	ErrSiteNotFound   = "site_not_found"
	ErrSiteDisabled   = "site_disabled"
	ErrAgentNotFound  = "agent_not_found"
	ErrAgentDisabled  = "agent_disabled"
	ErrAgentAuth      = "agent_unauthorized"
	ErrDeviceNotFound = "device_not_found"
	ErrDeviceRevoked  = "device_revoked"
	ErrInvalidRequest = "invalid_request"
	ErrAlreadyExists  = "already_exists"
)

// DefaultInviteTTL is how long an Invite stays redeemable. Short-lived on
// purpose: it only bootstraps pairing, then a long-lived Device is minted.
const DefaultInviteTTL = 24 * time.Hour

// PairError carries a stable machine-readable code plus a human message.
type PairError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *PairError) Error() string { return e.Code + ": " + e.Message }

func perr(code, msg string) *PairError { return &PairError{Code: code, Message: msg} }

// Site is the Relay-side record for one website origin.
type Site struct {
	SiteID      string `json:"siteId"`
	Origin      string `json:"origin"`
	DisplayName string `json:"displayName"`
	Enabled     bool   `json:"enabled"`
	CreatedAt   string `json:"createdAt"`
}

// Agent is one Hermes Adapter identity. CredentialHash is the SHA-256 digest of
// the agent's opaque bearer credential and is never serialized.
type Agent struct {
	AgentID        string `json:"agentId"`
	DisplayName    string `json:"displayName"`
	CredentialHash string `json:"-"`
	Enabled        bool   `json:"enabled"`
	CreatedAt      string `json:"createdAt"`
}

// Invite is a single-use, short-lived, Site-scoped onboarding token. TokenHash
// is the SHA-256 digest of the raw token; the raw token is never stored.
type Invite struct {
	InviteID   string `json:"inviteId"`
	TokenHash  string `json:"-"`
	SiteID     string `json:"siteId"`
	ExpiresAt  string `json:"expiresAt"`
	RedeemedAt string `json:"redeemedAt,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

// Device is one paired browser/extension instance, scoped to granted Sites.
type Device struct {
	DeviceID       string   `json:"deviceId"`
	CredentialHash string   `json:"-"`
	RevokedAt      string   `json:"revokedAt,omitempty"`
	CreatedAt      string   `json:"createdAt"`
	Sites          []string `json:"sites"`
}

// migrations are applied in order at startup; each entry is one DDL statement.
// The applied version is recorded in schema_migrations so the mechanism is
// deterministic and idempotent.
var migrations = []string{
	`CREATE TABLE sites (
		site_id      TEXT PRIMARY KEY,
		origin       TEXT NOT NULL,
		display_name TEXT NOT NULL,
		enabled      INTEGER NOT NULL DEFAULT 1,
		created_at   TEXT NOT NULL
	)`,
	`CREATE TABLE agents (
		agent_id        TEXT PRIMARY KEY,
		display_name    TEXT NOT NULL,
		credential_hash TEXT NOT NULL,
		enabled         INTEGER NOT NULL DEFAULT 1,
		created_at      TEXT NOT NULL
	)`,
	`CREATE TABLE agent_sites (
		agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
		site_id  TEXT NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
		PRIMARY KEY (agent_id, site_id)
	)`,
	`CREATE TABLE invites (
		invite_id   TEXT PRIMARY KEY,
		token_hash  TEXT NOT NULL UNIQUE,
		site_id     TEXT NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
		expires_at  TEXT NOT NULL,
		redeemed_at TEXT NOT NULL DEFAULT '',
		created_at  TEXT NOT NULL
	)`,
	`CREATE TABLE devices (
		device_id       TEXT PRIMARY KEY,
		credential_hash TEXT NOT NULL,
		revoked_at      TEXT NOT NULL DEFAULT '',
		created_at      TEXT NOT NULL
	)`,
	`CREATE TABLE device_sites (
		device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
		site_id   TEXT NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
		PRIMARY KEY (device_id, site_id)
	)`,
	`CREATE TABLE jobs (
		job_id       TEXT PRIMARY KEY,
		device_id    TEXT NOT NULL,
		payload_hash TEXT NOT NULL,
		status       TEXT NOT NULL,
		result       TEXT NOT NULL DEFAULT '',
		created_at   TEXT NOT NULL
	)`,
}

// Store wraps a SQLite database handle. It is safe for concurrent use (the
// connection pool is pinned to 1, which also avoids SQLITE_BUSY in a small
// single-relay deployment).
type Store struct {
	db *sql.DB
}

// Open opens (creating if necessary) the SQLite database at path and applies
// any pending migrations.
func Open(path string) (*Store, error) {
	dsn := "file:" + path +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close releases the underlying connection.
func (s *Store) Close() error { return s.db.Close() }

// Ready reports whether the DB is reachable and all migrations are applied.
// Used by GET /readyz.
func (s *Store) Ready() error {
	var applied int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&applied); err != nil {
		return fmt.Errorf("db unreachable: %w", err)
	}
	if applied != len(migrations) {
		return fmt.Errorf("migrations incomplete: %d/%d applied", applied, len(migrations))
	}
	return nil
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	for i, stmt := range migrations {
		version := i + 1
		var exists int
		if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&exists); err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if exists > 0 {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", version, err)
		}
		if _, err := tx.Exec(stmt); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %d: %w", version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, now()); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %d: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", version, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

func (s *Store) CreateSite(siteID, origin, displayName string) (Site, error) {
	if siteID == "" || origin == "" || displayName == "" {
		return Site{}, perr(ErrInvalidRequest, "siteId, origin and displayName are required")
	}
	site := Site{SiteID: siteID, Origin: origin, DisplayName: displayName, Enabled: true, CreatedAt: now()}
	_, err := s.db.Exec(`INSERT INTO sites (site_id, origin, display_name, enabled, created_at) VALUES (?, ?, ?, 1, ?)`,
		site.SiteID, site.Origin, site.DisplayName, site.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return Site{}, perr(ErrAlreadyExists, "site already exists")
		}
		return Site{}, fmt.Errorf("insert site: %w", err)
	}
	return site, nil
}

func (s *Store) GetSite(siteID string) (Site, bool) {
	var st Site
	var enabled int
	err := s.db.QueryRow(`SELECT site_id, origin, display_name, enabled, created_at FROM sites WHERE site_id = ?`, siteID).
		Scan(&st.SiteID, &st.Origin, &st.DisplayName, &enabled, &st.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Site{}, false
	}
	if err != nil {
		return Site{}, false
	}
	st.Enabled = enabled != 0
	return st, true
}

func (s *Store) ListSites() ([]Site, error) {
	rows, err := s.db.Query(`SELECT site_id, origin, display_name, enabled, created_at FROM sites ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Site
	for rows.Next() {
		var st Site
		var enabled int
		if err := rows.Scan(&st.SiteID, &st.Origin, &st.DisplayName, &enabled, &st.CreatedAt); err != nil {
			return nil, err
		}
		st.Enabled = enabled != 0
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *Store) SetSiteEnabled(siteID string, enabled bool) error {
	flag := 0
	if enabled {
		flag = 1
	}
	res, err := s.db.Exec(`UPDATE sites SET enabled = ? WHERE site_id = ?`, flag, siteID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return perr(ErrSiteNotFound, "unknown site")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

// CreateAgent mints an agent and its opaque bearer credential. The raw
// credential is returned exactly once for the operator to hand to the Adapter;
// only its hash is stored.
func (s *Store) CreateAgent(agentID, displayName string) (Agent, string, error) {
	if agentID == "" || displayName == "" {
		return Agent{}, "", perr(ErrInvalidRequest, "agentId and displayName are required")
	}
	cred := newCredential("uba_")
	ag := Agent{AgentID: agentID, DisplayName: displayName, CredentialHash: hashCredential(cred), Enabled: true, CreatedAt: now()}
	_, err := s.db.Exec(`INSERT INTO agents (agent_id, display_name, credential_hash, enabled, created_at) VALUES (?, ?, ?, 1, ?)`,
		ag.AgentID, ag.DisplayName, ag.CredentialHash, ag.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return Agent{}, "", perr(ErrAlreadyExists, "agent already exists")
		}
		return Agent{}, "", fmt.Errorf("insert agent: %w", err)
	}
	return ag, cred, nil
}

func (s *Store) ListAgents() ([]Agent, error) {
	rows, err := s.db.Query(`SELECT agent_id, display_name, enabled, created_at FROM agents ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		var a Agent
		var enabled int
		if err := rows.Scan(&a.AgentID, &a.DisplayName, &enabled, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Enabled = enabled != 0
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) SetAgentEnabled(agentID string, enabled bool) error {
	flag := 0
	if enabled {
		flag = 1
	}
	res, err := s.db.Exec(`UPDATE agents SET enabled = ? WHERE agent_id = ?`, flag, agentID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return perr(ErrAgentNotFound, "unknown agent")
	}
	return nil
}

// GrantSite authorizes an agent to serve a site. The Relay is authoritative:
// an agent can never self-declare site ownership.
func (s *Store) GrantSite(agentID, siteID string) error {
	if _, ok := s.getAgent(agentID); !ok {
		return perr(ErrAgentNotFound, "unknown agent")
	}
	if _, ok := s.GetSite(siteID); !ok {
		return perr(ErrSiteNotFound, "unknown site")
	}
	if _, err := s.db.Exec(`INSERT INTO agent_sites (agent_id, site_id) VALUES (?, ?)`, agentID, siteID); err != nil {
		if isUniqueViolation(err) {
			return nil // idempotent
		}
		return fmt.Errorf("grant site: %w", err)
	}
	return nil
}

func (s *Store) RevokeSite(agentID, siteID string) error {
	if _, err := s.db.Exec(`DELETE FROM agent_sites WHERE agent_id = ? AND site_id = ?`, agentID, siteID); err != nil {
		return err
	}
	return nil
}

func (s *Store) AgentSites(agentID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT site_id FROM agent_sites WHERE agent_id = ? ORDER BY site_id`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			return nil, err
		}
		out = append(out, sid)
	}
	return out, rows.Err()
}

// AgentsForSite returns the enabled agents authorized to serve the given site.
func (s *Store) AgentsForSite(siteID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT a.agent_id FROM agents a JOIN agent_sites ag ON a.agent_id = ag.agent_id WHERE ag.site_id = ? AND a.enabled = 1 ORDER BY a.agent_id`, siteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var aid string
		if err := rows.Scan(&aid); err != nil {
			return nil, err
		}
		out = append(out, aid)
	}
	return out, rows.Err()
}

// AgentsDetailedForSite returns the enabled agents authorized to serve the site,
// with the display name the operator gave them. This is the source the browser
// UI lists: only agents that are allowed for THAT site ever appear.
func (s *Store) AgentsDetailedForSite(siteID string) ([]Agent, error) {
	rows, err := s.db.Query(`SELECT a.agent_id, a.display_name, a.enabled, a.created_at
		FROM agents a JOIN agent_sites ag ON a.agent_id = ag.agent_id
		WHERE ag.site_id = ? AND a.enabled = 1 ORDER BY a.display_name, a.agent_id`, siteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		var ag Agent
		if err := rows.Scan(&ag.AgentID, &ag.DisplayName, &ag.Enabled, &ag.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, ag)
	}
	return out, rows.Err()
}

// AgentAllowedForSite reports whether the agent is enabled AND granted this
// site. A client-supplied agentId is only ever accepted on the strength of this
// check — never on the client's word.
func (s *Store) AgentAllowedForSite(siteID, agentID string) (bool, error) {
	if agentID == "" {
		return false, nil
	}
	var n int
	err := s.db.QueryRow(`SELECT COUNT(1) FROM agents a JOIN agent_sites ag ON a.agent_id = ag.agent_id
		WHERE ag.site_id = ? AND a.agent_id = ? AND a.enabled = 1`, siteID, agentID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// AuthenticateAgent resolves an agent from its credential and returns the agent
// plus its authorized Sites. ok is false when the credential is wrong or the
// agent is disabled.
func (s *Store) AuthenticateAgent(agentID, credential string) (Agent, []string, bool) {
	ag, ok := s.getAgent(agentID)
	if !ok || !ag.Enabled || ag.CredentialHash != hashCredential(credential) {
		return Agent{}, nil, false
	}
	sites, err := s.AgentSites(agentID)
	if err != nil {
		return Agent{}, nil, false
	}
	return ag, sites, true
}

func (s *Store) getAgent(agentID string) (Agent, bool) {
	var a Agent
	var enabled int
	err := s.db.QueryRow(`SELECT agent_id, display_name, credential_hash, enabled, created_at FROM agents WHERE agent_id = ?`, agentID).
		Scan(&a.AgentID, &a.DisplayName, &a.CredentialHash, &enabled, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, false
	}
	if err != nil {
		return Agent{}, false
	}
	a.Enabled = enabled != 0
	return a, true
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// CreateInvite mints a single-use, Site-scoped Invite and returns its raw token
// exactly once (for the .ullabella file). Only the token hash is stored.
func (s *Store) CreateInvite(siteID string, ttl time.Duration) (Invite, string, error) {
	if ttl == 0 {
		ttl = DefaultInviteTTL
	}
	site, ok := s.GetSite(siteID)
	if !ok {
		return Invite{}, "", perr(ErrSiteNotFound, "unknown site")
	}
	if !site.Enabled {
		return Invite{}, "", perr(ErrSiteDisabled, "site is disabled")
	}
	token := newCredential("ub_")
	inv := Invite{
		InviteID:  "inv_" + randomHex(8),
		TokenHash: hashCredential(token),
		SiteID:    siteID,
		ExpiresAt: nowAdd(ttl),
		CreatedAt: now(),
	}
	_, err := s.db.Exec(`INSERT INTO invites (invite_id, token_hash, site_id, expires_at, redeemed_at, created_at) VALUES (?, ?, ?, ?, '', ?)`,
		inv.InviteID, inv.TokenHash, inv.SiteID, inv.ExpiresAt, inv.CreatedAt)
	if err != nil {
		return Invite{}, "", fmt.Errorf("insert invite: %w", err)
	}
	return inv, token, nil
}

// RedeemInvite validates a raw Invite token (hashed before lookup), mints a
// scoped Device with a fresh credential, marks the Invite used, and returns the
// raw Device credential exactly once. The whole operation is transactional so a
// redemption stays single-use across processes.
func (s *Store) RedeemInvite(token string) (Device, string, Site, error) {
	h := hashCredential(token)

	tx, err := s.db.Begin()
	if err != nil {
		return Device{}, "", Site{}, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit

	var inv Invite
	var redeemedAt string
	err = tx.QueryRow(`SELECT invite_id, token_hash, site_id, expires_at, redeemed_at, created_at FROM invites WHERE token_hash = ?`, h).
		Scan(&inv.InviteID, &inv.TokenHash, &inv.SiteID, &inv.ExpiresAt, &redeemedAt, &inv.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, "", Site{}, perr(ErrInviteNotFound, "invite not found")
	}
	if err != nil {
		return Device{}, "", Site{}, fmt.Errorf("lookup invite: %w", err)
	}
	if redeemedAt != "" {
		return Device{}, "", Site{}, perr(ErrInviteUsed, "invite already used")
	}
	if exp, err := time.Parse(time.RFC3339, inv.ExpiresAt); err != nil || time.Now().UTC().After(exp) {
		return Device{}, "", Site{}, perr(ErrInviteExpired, "invite expired")
	}

	var site Site
	var enabled int
	err = tx.QueryRow(`SELECT site_id, origin, display_name, enabled, created_at FROM sites WHERE site_id = ?`, inv.SiteID).
		Scan(&site.SiteID, &site.Origin, &site.DisplayName, &enabled, &site.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, "", Site{}, perr(ErrSiteNotFound, "site no longer exists")
	}
	if err != nil {
		return Device{}, "", Site{}, fmt.Errorf("lookup site: %w", err)
	}
	site.Enabled = enabled != 0
	if !site.Enabled {
		return Device{}, "", Site{}, perr(ErrSiteDisabled, "site is disabled")
	}

	cred := newCredential("ubd_")
	dev := Device{
		DeviceID:       "dev_" + randomHex(8),
		CredentialHash: hashCredential(cred),
		CreatedAt:      now(),
		Sites:          []string{site.SiteID},
	}

	if _, err := tx.Exec(`INSERT INTO devices (device_id, credential_hash, revoked_at, created_at) VALUES (?, ?, '', ?)`,
		dev.DeviceID, dev.CredentialHash, dev.CreatedAt); err != nil {
		return Device{}, "", Site{}, fmt.Errorf("insert device: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO device_sites (device_id, site_id) VALUES (?, ?)`, dev.DeviceID, site.SiteID); err != nil {
		return Device{}, "", Site{}, fmt.Errorf("insert device_sites: %w", err)
	}
	if _, err := tx.Exec(`UPDATE invites SET redeemed_at = ? WHERE invite_id = ?`, now(), inv.InviteID); err != nil {
		return Device{}, "", Site{}, fmt.Errorf("mark invite used: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return Device{}, "", Site{}, fmt.Errorf("commit redemption: %w", err)
	}
	return dev, cred, site, nil
}

// ListInvites returns invite metadata (never raw tokens — those are never
// stored; only hashes exist at rest).
func (s *Store) ListInvites() ([]Invite, error) {
	rows, err := s.db.Query(`SELECT invite_id, site_id, expires_at, redeemed_at, created_at FROM invites ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var inv Invite
		if err := rows.Scan(&inv.InviteID, &inv.SiteID, &inv.ExpiresAt, &inv.RedeemedAt, &inv.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

// AuthenticateDevice resolves an active (non-revoked) Device from its bearer
// credential and returns it with its allowed Sites. ok is false on unknown or
// revoked credentials.
func (s *Store) AuthenticateDevice(credential string) (Device, bool) {
	h := hashCredential(credential)
	dev, ok := s.deviceByCredHash(h)
	if !ok {
		return Device{}, false
	}
	sites, err := s.deviceSites(dev.DeviceID)
	if err != nil {
		return Device{}, false
	}
	dev.Sites = sites
	return dev, true
}

func (s *Store) GetDevice(deviceID string) (Device, bool) {
	dev, ok := s.deviceByID(deviceID)
	if !ok {
		return Device{}, false
	}
	sites, err := s.deviceSites(deviceID)
	if err == nil {
		dev.Sites = sites
	}
	return dev, true
}

func (s *Store) ListDevices() ([]Device, error) {
	rows, err := s.db.Query(`SELECT device_id, revoked_at, created_at FROM devices ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.DeviceID, &d.RevokedAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		if sites, err := s.deviceSites(d.DeviceID); err == nil {
			d.Sites = sites
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RevokeDevice marks a device revoked. Its credential immediately loses all
// authority (new Jobs fail, result access fails).
func (s *Store) RevokeDevice(deviceID string) error {
	res, err := s.db.Exec(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, now(), deviceID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return perr(ErrDeviceNotFound, "unknown device")
	}
	return nil
}

// RotateDevice mints a fresh credential for an active device. The old
// credential stops working; the new raw credential is returned exactly once.
func (s *Store) RotateDevice(deviceID string) (string, error) {
	dev, ok := s.deviceByID(deviceID)
	if !ok {
		return "", perr(ErrDeviceNotFound, "unknown device")
	}
	if dev.RevokedAt != "" {
		return "", perr(ErrDeviceRevoked, "device is revoked")
	}
	cred := newCredential("ubd_")
	if _, err := s.db.Exec(`UPDATE devices SET credential_hash = ? WHERE device_id = ?`, hashCredential(cred), deviceID); err != nil {
		return "", err
	}
	return cred, nil
}

func (s *Store) deviceByCredHash(h string) (Device, bool) {
	var d Device
	var revokedAt string
	err := s.db.QueryRow(`SELECT device_id, credential_hash, revoked_at, created_at FROM devices WHERE credential_hash = ?`, h).
		Scan(&d.DeviceID, &d.CredentialHash, &revokedAt, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, false
	}
	if err != nil {
		return Device{}, false
	}
	d.RevokedAt = revokedAt
	if revokedAt != "" {
		return Device{}, false // revoked devices never authenticate
	}
	return d, true
}

func (s *Store) deviceByID(deviceID string) (Device, bool) {
	var d Device
	err := s.db.QueryRow(`SELECT device_id, credential_hash, revoked_at, created_at FROM devices WHERE device_id = ?`, deviceID).
		Scan(&d.DeviceID, &d.CredentialHash, &d.RevokedAt, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, false
	}
	if err != nil {
		return Device{}, false
	}
	return d, true
}

func (s *Store) deviceSites(deviceID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT site_id FROM device_sites WHERE device_id = ? ORDER BY site_id`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			return nil, err
		}
		out = append(out, sid)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// Job is the Relay's persisted record of an accepted job: its owning device,
// the canonical payload hash (for idempotent dedup), the lifecycle status, and
// the stored result envelope (initialized to the accepted envelope).
type Job struct {
	JobID       string
	DeviceID    string
	PayloadHash string
	Status      string
	Result      string
}

// CreateJob inserts a new job record. Returns ErrAlreadyExists when the jobId
// is already taken (the caller treats that as an idempotency/conflict case).
func (s *Store) CreateJob(jobID, deviceID, payloadHash, status, result string) error {
	_, err := s.db.Exec(`INSERT INTO jobs (job_id, device_id, payload_hash, status, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		jobID, deviceID, payloadHash, status, result, now())
	if err != nil {
		if isUniqueViolation(err) {
			return perr(ErrAlreadyExists, "job already exists")
		}
		return fmt.Errorf("insert job: %w", err)
	}
	return nil
}

// GetJob returns a persisted job record, or ok=false.
func (s *Store) GetJob(jobID string) (Job, bool) {
	var j Job
	err := s.db.QueryRow(`SELECT job_id, device_id, payload_hash, status, result FROM jobs WHERE job_id = ?`, jobID).
		Scan(&j.JobID, &j.DeviceID, &j.PayloadHash, &j.Status, &j.Result)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false
	}
	if err != nil {
		return Job{}, false
	}
	return j, true
}

// SetJobResult updates a job's status and stored result envelope, enforcing the
// terminal-state invariant: a terminal result (done/error) is never overwritten
// by a later non-terminal (accepted/working) result — a late activity/working
// update must not clobber an already-settled job. It reports whether the update
// was applied (false when a stale non-terminal result was ignored).
func (s *Store) SetJobResult(jobID, status, result string) (bool, error) {
	q := `UPDATE jobs SET status = ?, result = ? WHERE job_id = ?`
	if !isTerminalJobStatus(status) {
		q = `UPDATE jobs SET status = ?, result = ? WHERE job_id = ? AND status NOT IN ('done','error')`
	}
	res, err := s.db.Exec(q, status, result, jobID)
	if err != nil {
		return false, fmt.Errorf("set job result: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// isTerminalJobStatus reports whether a job status settles the job.
func isTerminalJobStatus(status string) bool {
	return status == "done" || status == "error"
}

// InterruptNonTerminal marks every job still in "accepted" status as error at
// Relay startup, using the result envelope built by resultFor. A job in
// "working" status is deliberately left alone: with durable Hermes runs the
// Adapter has already recorded it and will resume/re-deliver the result after
// reconnecting, so failing it here would falsely report a recoverable run as
// permanently failed. Only "accepted" (the Adapter never confirmed receipt) is
// genuinely orphaned by a restart.
func (s *Store) InterruptNonTerminal(resultFor func(jobID string) string) error {
	rows, err := s.db.Query(`SELECT job_id FROM jobs WHERE status = 'accepted'`)
	if err != nil {
		return fmt.Errorf("list non-terminal jobs: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(`UPDATE jobs SET status = 'error', result = ? WHERE job_id = ?`, resultFor(id), id); err != nil {
			return fmt.Errorf("interrupt job %s: %w", id, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

// newCredential returns a high-entropy opaque bearer credential: prefix + 64 hex
// chars (256 bits). It is minted once, hashed, and never stored in plaintext.
func newCredential(prefix string) string {
	return prefix + randomHex(32)
}

// hashCredential returns the SHA-256 hex digest used as the stored form.
func hashCredential(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// randomHex returns n random bytes hex-encoded (2n chars).
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("store: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func nowAdd(d time.Duration) string { return time.Now().UTC().Add(d).Format(time.RFC3339) }

// isUniqueViolation reports whether err is a SQLite UNIQUE/PK constraint error.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "PRIMARY KEY constraint failed")
}
