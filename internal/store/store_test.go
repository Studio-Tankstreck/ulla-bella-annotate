package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func seedSite(t *testing.T, s *Store, siteID, origin, name string) Site {
	t.Helper()
	st, err := s.CreateSite(siteID, origin, name)
	if err != nil {
		t.Fatalf("CreateSite: %v", err)
	}
	return st
}

// TestFreshAndReopen verifies a fresh DB applies all migrations, and that
// reopening is idempotent (no re-apply, data survives).
func TestFreshAndReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.Ready(); err != nil {
		t.Fatalf("Ready after open: %v", err)
	}
	seedSite(t, s, "site_a", "https://a.test", "A")
	_ = s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if err := s2.Ready(); err != nil {
		t.Fatalf("Ready after reopen: %v", err)
	}
	if st, ok := s2.GetSite("site_a"); !ok || st.DisplayName != "A" {
		t.Fatalf("site did not survive reopen: %+v ok=%v", st, ok)
	}

	// Migration version table must be full and stable.
	var applied int
	if err := s2.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != len(migrations) {
		t.Fatalf("applied %d migrations, want %d", applied, len(migrations))
	}
}

func TestSiteLifecycle(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")

	if _, err := s.CreateSite("site_a", "https://b.test", "Dup"); err == nil {
		t.Fatal("duplicate site should fail")
	}

	// Disable.
	if err := s.SetSiteEnabled("site_a", false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if st, _ := s.GetSite("site_a"); st.Enabled {
		t.Fatal("site should be disabled")
	}
	// Disabled site cannot mint invites.
	if _, _, err := s.CreateInvite("site_a", time.Minute); err == nil || !strings.Contains(err.Error(), ErrSiteDisabled) {
		t.Fatalf("invite on disabled site: want site_disabled, got %v", err)
	}
	// Re-enable.
	if err := s.SetSiteEnabled("site_a", true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if st, _ := s.GetSite("site_a"); !st.Enabled {
		t.Fatal("site should be enabled")
	}
}

func TestAgentAuth(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")
	seedSite(t, s, "site_b", "https://b.test", "B")

	ag, cred, err := s.CreateAgent("agent_1", "One")
	if err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if ag.CredentialHash == "" || ag.CredentialHash == cred {
		t.Fatal("agent credential must be stored as a hash")
	}
	if !strings.HasPrefix(cred, "uba_") {
		t.Fatalf("agent credential prefix = %q", cred[:4])
	}

	if err := s.GrantSite("agent_1", "site_a"); err != nil {
		t.Fatalf("GrantSite: %v", err)
	}
	if err := s.GrantSite("agent_1", "site_b"); err != nil {
		t.Fatalf("GrantSite: %v", err)
	}

	got, sites, ok := s.AuthenticateAgent("agent_1", cred)
	if !ok || got.AgentID != "agent_1" || len(sites) != 2 {
		t.Fatalf("auth: got=%+v sites=%v ok=%v", got, sites, ok)
	}

	// Wrong credential.
	if _, _, ok := s.AuthenticateAgent("agent_1", "uba_wrong"); ok {
		t.Fatal("wrong agent credential must fail")
	}
	// Unknown agent.
	if _, _, ok := s.AuthenticateAgent("agent_nope", cred); ok {
		t.Fatal("unknown agent must fail")
	}

	// Grant for unknown agent / site fails.
	if err := s.GrantSite("agent_nope", "site_a"); err == nil || !strings.Contains(err.Error(), ErrAgentNotFound) {
		t.Fatalf("grant unknown agent: got %v", err)
	}
	if err := s.GrantSite("agent_1", "site_nope"); err == nil || !strings.Contains(err.Error(), ErrSiteNotFound) {
		t.Fatalf("grant unknown site: got %v", err)
	}

	// Revoke a site.
	if err := s.RevokeSite("agent_1", "site_b"); err != nil {
		t.Fatalf("RevokeSite: %v", err)
	}
	if _, sites, _ := s.AuthenticateAgent("agent_1", cred); len(sites) != 1 || sites[0] != "site_a" {
		t.Fatalf("after revoke, sites = %v", sites)
	}
}

func TestInviteHashAtRest(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")

	inv, token, err := s.CreateInvite("site_a", time.Minute)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if inv.TokenHash == "" || inv.TokenHash == token {
		t.Fatal("invite token must be stored as a hash")
	}
	if inv.TokenHash != hashCredential(token) {
		t.Fatal("stored hash does not match raw token hash")
	}

	// Raw token must not exist anywhere in the DB file/rows.
	var raw string
	if err := s.db.QueryRow(`SELECT token_hash FROM invites WHERE token_hash = ?`, token).Scan(&raw); err != sql.ErrNoRows {
		t.Fatalf("raw token found at rest (err=%v)", err)
	}
	// And the hashed form must be the only stored value.
	var stored string
	if err := s.db.QueryRow(`SELECT token_hash FROM invites WHERE invite_id = ?`, inv.InviteID).Scan(&stored); err != nil {
		t.Fatalf("read stored token_hash: %v", err)
	}
	if stored != inv.TokenHash {
		t.Fatalf("stored token_hash %q != %q", stored, inv.TokenHash)
	}
}

func TestRedeemLifecycle(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")

	inv, token, _ := s.CreateInvite("site_a", time.Minute)
	dev, cred, site, err := s.RedeemInvite(token)
	if err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	if dev.DeviceID == "" || cred == "" || site.SiteID != "site_a" {
		t.Fatalf("redeem returned dev=%+v cred=%q site=%+v", dev, cred, site)
	}
	if !strings.HasPrefix(cred, "ubd_") {
		t.Fatalf("device credential prefix = %q", cred[:4])
	}
	if len(dev.Sites) != 1 || dev.Sites[0] != "site_a" {
		t.Fatalf("device sites = %v", dev.Sites)
	}

	// Reuse fails.
	if _, _, _, err := s.RedeemInvite(token); err == nil || !strings.Contains(err.Error(), ErrInviteUsed) {
		t.Fatalf("reuse: got %v", err)
	}
	// Random token fails.
	if _, _, _, err := s.RedeemInvite("ub_doesnotexist"); err == nil || !strings.Contains(err.Error(), ErrInviteNotFound) {
		t.Fatalf("random token: got %v", err)
	}
	// The credential authenticates the device.
	got, ok := s.AuthenticateDevice(cred)
	if !ok || got.DeviceID != dev.DeviceID {
		t.Fatalf("AuthenticateDevice: got=%+v ok=%v", got, ok)
	}
	_ = inv
}

func TestExpiredInvite(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")
	_, token, _ := s.CreateInvite("site_a", -time.Minute) // pre-expired
	if _, _, _, err := s.RedeemInvite(token); err == nil || !strings.Contains(err.Error(), ErrInviteExpired) {
		t.Fatalf("expired invite: got %v", err)
	}
}

func TestRedemptionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	seedSite(t, s, "site_a", "https://a.test", "A")
	_, token, _ := s.CreateInvite("site_a", time.Minute)
	dev, cred, _, err := s.RedeemInvite(token)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	// Reuse after restart still fails (single-use is persisted).
	if _, _, _, err := s2.RedeemInvite(token); err == nil || !strings.Contains(err.Error(), ErrInviteUsed) {
		t.Fatalf("reuse after restart: got %v", err)
	}
	// Device credential still works after restart.
	if got, ok := s2.AuthenticateDevice(cred); !ok || got.DeviceID != dev.DeviceID {
		t.Fatalf("device auth after restart: got=%+v ok=%v", got, ok)
	}
}

func TestDeviceRevokeAndRotate(t *testing.T) {
	s := openTest(t)
	seedSite(t, s, "site_a", "https://a.test", "A")
	_, token, _ := s.CreateInvite("site_a", time.Minute)
	dev, cred, _, _ := s.RedeemInvite(token)

	// Rotate: old cred dies, new cred returned once.
	newCred, err := s.RotateDevice(dev.DeviceID)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if newCred == cred {
		t.Fatal("rotate must mint a different credential")
	}
	if _, ok := s.AuthenticateDevice(cred); ok {
		t.Fatal("old credential must stop working after rotation")
	}
	if _, ok := s.AuthenticateDevice(newCred); !ok {
		t.Fatal("new credential must work after rotation")
	}

	// Revoke: new cred dies too.
	if err := s.RevokeDevice(dev.DeviceID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok := s.AuthenticateDevice(newCred); ok {
		t.Fatal("revoked device must not authenticate")
	}
	// Rotating a revoked device fails.
	if _, err := s.RotateDevice(dev.DeviceID); err == nil || !strings.Contains(err.Error(), ErrDeviceRevoked) {
		t.Fatalf("rotate revoked device: got %v", err)
	}
	// Revoking an unknown device fails.
	if err := s.RevokeDevice("dev_nope"); err == nil || !strings.Contains(err.Error(), ErrDeviceNotFound) {
		t.Fatalf("revoke unknown: got %v", err)
	}
}
