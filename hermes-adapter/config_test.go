package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) *Config {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "adapter.yaml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return cfg
}

const validConfigYAML = `
relay:
  url: wss://relay.example.com/v1/ws
agent:
  id: agent_test
  credential_env: ULLABELLA_AGENT_CREDENTIAL
hermes:
  base_url: http://127.0.0.1:8642/v1
  model: hermes-agent
  api_key_env: API_SERVER_KEY
sites:
  - site_id: site_one
    origin: https://example.com
    tool:
      type: yootheme-mcp
      endpoint: https://mcp.example.com/api/index.php/v1/yt-builder-mcp
      token_env: EXAMPLE_YTB_MCP_TOKEN
`

func withSecrets(t *testing.T, f func()) {
	t.Helper()
	t.Setenv("ULLABELLA_AGENT_CREDENTIAL", "uba_test")
	t.Setenv("API_SERVER_KEY", "k_test")
	t.Setenv("EXAMPLE_YTB_MCP_TOKEN", "t_test")
	f()
}

func hasErrorContaining(errs []error, sub string) bool {
	for _, e := range errs {
		if strings.Contains(e.Error(), sub) {
			return true
		}
	}
	return false
}

func TestConfigValid(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML)
		if errs := cfg.validate(); len(errs) != 0 {
			t.Fatalf("expected valid config, got %v", errs)
		}
	})
}

func TestConfigMissingAgentCredentialSecret(t *testing.T) {
	// ULLABELLA_AGENT_CREDENTIAL intentionally NOT set
	t.Setenv("API_SERVER_KEY", "k")
	t.Setenv("EXAMPLE_YTB_MCP_TOKEN", "t")
	cfg := writeConfig(t, validConfigYAML)
	if errs := cfg.validate(); !hasErrorContaining(errs, "agent credential") {
		t.Fatalf("expected missing agent credential error, got %v", errs)
	}
}

func TestConfigMissingSiteTokenSecret(t *testing.T) {
	t.Setenv("ULLABELLA_AGENT_CREDENTIAL", "c")
	t.Setenv("API_SERVER_KEY", "k")
	// EXAMPLE_YTB_MCP_TOKEN intentionally NOT set
	cfg := writeConfig(t, validConfigYAML)
	if errs := cfg.validate(); !hasErrorContaining(errs, "MCP token") {
		t.Fatalf("expected missing MCP token error, got %v", errs)
	}
}

func TestConfigMissingAgentCredentialRef(t *testing.T) {
	cfg := writeConfig(t, `
relay:
  url: wss://relay.example.com/v1/ws
agent:
  id: agent_test
hermes:
  base_url: http://127.0.0.1:8642
  model: hermes-agent
  api_key_env: API_SERVER_KEY
sites: []
`)
	if errs := cfg.validate(); !hasErrorContaining(errs, "agent.credential_env is required") {
		t.Fatalf("expected missing credential_env error, got %v", errs)
	}
}

func TestConfigDuplicateSite(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML+`
  - site_id: site_one
    origin: https://other.example.com
    tool:
      type: yootheme-mcp
      endpoint: https://mcp.example.com/x
      token_env: EXAMPLE_YTB_MCP_TOKEN
`)
		if errs := cfg.validate(); !hasErrorContaining(errs, "duplicate site_id") {
			t.Fatalf("expected duplicate site error, got %v", errs)
		}
	})
}

func TestConfigUnsupportedTool(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML+`
  - site_id: site_two
    origin: https://other.example.com
    tool:
      type: wordpress
`)
		if errs := cfg.validate(); !hasErrorContaining(errs, "unsupported tool type") {
			t.Fatalf("expected unsupported tool error, got %v", errs)
		}
	})
}

func TestConfigMalformedRelayURL(t *testing.T) {
	cfg := writeConfig(t, strings.Replace(validConfigYAML, "wss://relay.example.com/v1/ws", "not-a-url", 1))
	if errs := cfg.validate(); !hasErrorContaining(errs, "relay.url") {
		t.Fatalf("expected malformed relay.url error, got %v", errs)
	}
}

func TestConfigMalformedOrigin(t *testing.T) {
	cfg := writeConfig(t, strings.Replace(validConfigYAML, "https://example.com", "example", 1))
	if errs := cfg.validate(); !hasErrorContaining(errs, "origin must be an absolute") {
		t.Fatalf("expected malformed origin error, got %v", errs)
	}
}

func TestSiteMapYoothemeMCP(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML)
		m := cfg.siteMap()
		sc, ok := m["site_one"]
		if !ok {
			t.Fatal("site_one missing from siteMap")
		}
		if sc.EditingMode != editingModeYoothemeMCP {
			t.Fatalf("editingMode = %q", sc.EditingMode)
		}
		if sc.MCP == nil || sc.MCP.Endpoint == "" || sc.MCP.TokenEnvVar != "EXAMPLE_YTB_MCP_TOKEN" {
			t.Fatalf("MCP config wrong: %+v", sc.MCP)
		}
		if sc.MCP.ClientVersion != defaultMCPClientVersion {
			t.Fatalf("client version = %q want default %q", sc.MCP.ClientVersion, defaultMCPClientVersion)
		}
	})
}

func TestEffectiveSites(t *testing.T) {
	local := map[string]SiteConfig{
		"site_a": {SiteID: "site_a"},
		"site_b": {SiteID: "site_b"},
	}
	eff, missing := effectiveSites(local, []string{"site_a", "site_c"})
	if _, ok := eff["site_a"]; !ok {
		t.Fatal("site_a should be effective (granted + configured)")
	}
	if _, ok := eff["site_b"]; ok {
		t.Fatal("site_b must NOT be effective (configured but not granted)")
	}
	if len(missing) != 1 || missing[0] != "site_c" {
		t.Fatalf("expected missing=[site_c], got %v", missing)
	}
}

func TestRelayHealthURL(t *testing.T) {
	for _, c := range []struct {
		in, want string
	}{
		{"ws://127.0.0.1:8787/v1/ws", "http://127.0.0.1:8787/healthz"},
		{"wss://relay.example.com/v1/ws", "https://relay.example.com/healthz"},
	} {
		got, ok := relayHealthURL(c.in)
		if !ok || got != c.want {
			t.Fatalf("relayHealthURL(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
}

func TestHermesOrigin(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"http://127.0.0.1:8642", "http://127.0.0.1:8642"},
		{"http://127.0.0.1:8642/v1", "http://127.0.0.1:8642"},
		{"http://127.0.0.1:8642/v1/", "http://127.0.0.1:8642"},
	} {
		if got := hermesOrigin(c.in); got != c.want {
			t.Fatalf("hermesOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestLoadEnvFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "adapter.env")
	content := "# comment\nULLABELLA_AGENT_CREDENTIAL=sec\nAPI_SERVER_KEY=with=equals\n"
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := loadEnvFile(p); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("ULLABELLA_AGENT_CREDENTIAL") != "sec" {
		t.Fatalf("agent credential not loaded")
	}
	if os.Getenv("API_SERVER_KEY") != "with=equals" {
		t.Fatalf("value with '=' not loaded correctly")
	}
}
