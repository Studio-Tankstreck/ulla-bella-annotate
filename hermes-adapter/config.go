package main

import (
	"fmt"
	"net/url"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the Adapter's on-disk configuration (e.g. /etc/ulla-bella/adapter.yaml).
// It holds NO secrets: every secret is referenced by the NAME of an environment
// variable (agent.credential_env, hermes.api_key_env, sites[].tool.token_env) and
// the value is read from the process environment at runtime. This keeps secrets
// out of the readable config file and out of Git.
type Config struct {
	Relay  RelayConfig  `yaml:"relay"`
	Agent  AgentConfig  `yaml:"agent"`
	Hermes HermesConfig `yaml:"hermes"`
	Sites  []SiteEntry  `yaml:"sites"`
}

// RelayConfig is the outbound Relay connection the Adapter initiates.
type RelayConfig struct {
	// URL is the Relay WebSocket endpoint, e.g. wss://relay.example.com/v1/ws.
	URL string `yaml:"url"`
}

// AgentConfig is the Adapter's Relay-side identity.
type AgentConfig struct {
	// ID is the agent identifier minted by `relay agent create`.
	ID string `yaml:"id"`
	// CredentialEnv names the env var holding the agent credential (minted once
	// by `relay agent create`; never embedded here).
	CredentialEnv string `yaml:"credential_env"`
}

// HermesConfig describes the local Hermes gateway the Adapter drives.
type HermesConfig struct {
	BaseURL   string `yaml:"base_url"`    // e.g. http://127.0.0.1:8642 (or .../v1)
	Model     string `yaml:"model"`       // e.g. hermes-agent
	APIKeyEnv string `yaml:"api_key_env"` // env var holding the Hermes API key
}

// SiteEntry is one locally-configured Site: "I know how to operate Site X."
// It carries tool configuration only; authorization lives in the Relay DB.
type SiteEntry struct {
	SiteID string     `yaml:"site_id"`
	Origin string     `yaml:"origin"`
	Tool   ToolConfig `yaml:"tool"`
}

// ToolConfig is the smallest tool-type abstraction: `type` selects the executor
// mapping today (yootheme-mcp) and more later, without a plugin framework.
type ToolConfig struct {
	Type          string `yaml:"type"`                     // "yootheme-mcp" | "emdash"
	Endpoint      string `yaml:"endpoint,omitempty"`       // MCP base URL (no trailing /mcp) or EmDash API base URL
	TokenEnv      string `yaml:"token_env,omitempty"`      // env var holding the MCP/EmDash Bearer token
	HostHeader    string `yaml:"host_header,omitempty"`    // optional Host header override (tunnel/noncanonical endpoints)
	ClientVersion string `yaml:"client_version,omitempty"` // X-Ytb-Mcp-Client compat floor
	RepoPath      string `yaml:"repo_path,omitempty"`      // emdash: local source checkout for code/layout edits
	Workspace     string `yaml:"workspace,omitempty"`      // filesystem: local workspace dir for the isolated test site
	Skill         string `yaml:"skill,omitempty"`          // emdash: Hermes skill carrying the durable procedure
}

// defaultMCPClientVersion is the YOOtheme MCP client-version floor (Task 09B).
const defaultMCPClientVersion = "2.3.1"

// loadConfig reads and parses the YAML config file.
func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &cfg, nil
}

// validate returns every configuration problem. It is purely local: it never
// contacts or modifies any Site, Relay, or Hermes. It does read the process
// environment to detect missing referenced secrets.
func (c *Config) validate() []error {
	var errs []error

	// Relay
	switch {
	case c.Relay.URL == "":
		errs = append(errs, fmt.Errorf("relay.url is required"))
	default:
		if u, err := url.Parse(c.Relay.URL); err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
			errs = append(errs, fmt.Errorf("relay.url must be a ws:// or wss:// URL, got %q", c.Relay.URL))
		}
	}

	// Agent
	if c.Agent.ID == "" {
		errs = append(errs, fmt.Errorf("agent.id is required"))
	}
	if c.Agent.CredentialEnv == "" {
		errs = append(errs, fmt.Errorf("agent.credential_env is required"))
	} else if os.Getenv(c.Agent.CredentialEnv) == "" {
		errs = append(errs, fmt.Errorf("agent credential: env var %q is not set", c.Agent.CredentialEnv))
	}

	// Hermes
	if c.Hermes.BaseURL == "" {
		errs = append(errs, fmt.Errorf("hermes.base_url is required"))
	} else if u, err := url.Parse(c.Hermes.BaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("hermes.base_url must be an http(s) URL, got %q", c.Hermes.BaseURL))
	}
	if c.Hermes.Model == "" {
		errs = append(errs, fmt.Errorf("hermes.model is required"))
	}
	if c.Hermes.APIKeyEnv == "" {
		errs = append(errs, fmt.Errorf("hermes.api_key_env is required"))
	} else if os.Getenv(c.Hermes.APIKeyEnv) == "" {
		errs = append(errs, fmt.Errorf("hermes API key: env var %q is not set", c.Hermes.APIKeyEnv))
	}

	// Sites
	seen := map[string]bool{}
	for i, s := range c.Sites {
		idx := fmt.Sprintf("sites[%d]", i)
		if s.SiteID == "" {
			errs = append(errs, fmt.Errorf("%s: site_id is required", idx))
			continue
		}
		if seen[s.SiteID] {
			errs = append(errs, fmt.Errorf("site %q: duplicate site_id", s.SiteID))
		}
		seen[s.SiteID] = true
		if s.Origin == "" {
			errs = append(errs, fmt.Errorf("site %q: origin is required", s.SiteID))
		} else if u, err := url.Parse(s.Origin); err != nil || u.Scheme == "" || u.Host == "" {
			errs = append(errs, fmt.Errorf("site %q: origin must be an absolute scheme://host URL, got %q", s.SiteID, s.Origin))
		}
		switch s.Tool.Type {
		case "yootheme-mcp":
			if s.Tool.Endpoint == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.endpoint is required for yootheme-mcp", s.SiteID))
			} else if u, err := url.Parse(s.Tool.Endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.endpoint must be an http(s) URL, got %q", s.SiteID, s.Tool.Endpoint))
			}
			if s.Tool.TokenEnv == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.token_env is required for yootheme-mcp", s.SiteID))
			} else if os.Getenv(s.Tool.TokenEnv) == "" {
				errs = append(errs, fmt.Errorf("site %q: MCP token: env var %q is not set", s.SiteID, s.Tool.TokenEnv))
			}
		case "emdash":
			if s.Tool.Endpoint == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.endpoint is required for emdash", s.SiteID))
			} else if u, err := url.Parse(s.Tool.Endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.endpoint must be an http(s) URL, got %q", s.SiteID, s.Tool.Endpoint))
			}
			if s.Tool.TokenEnv == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.token_env is required for emdash", s.SiteID))
			} else if os.Getenv(s.Tool.TokenEnv) == "" {
				errs = append(errs, fmt.Errorf("site %q: EmDash token: env var %q is not set", s.SiteID, s.Tool.TokenEnv))
			}
		case "filesystem":
			if s.Tool.Workspace == "" {
				errs = append(errs, fmt.Errorf("site %q: tool.workspace is required for filesystem", s.SiteID))
			}
		case "":
			errs = append(errs, fmt.Errorf("site %q: tool.type is required", s.SiteID))
		default:
			errs = append(errs, fmt.Errorf("site %q: unsupported tool type %q", s.SiteID, s.Tool.Type))
		}
	}
	return errs
}

// siteMap converts the config's Site entries into the runtime SiteConfig map used
// by executor dispatch. It maps tool.type -> editing mode; unknown types are
// ignored here because validate() rejects them first.
func (c *Config) siteMap() map[string]SiteConfig {
	m := make(map[string]SiteConfig, len(c.Sites))
	for _, s := range c.Sites {
		sc := SiteConfig{SiteID: s.SiteID, Origin: s.Origin}
		switch s.Tool.Type {
		case "yootheme-mcp":
			ver := s.Tool.ClientVersion
			if ver == "" {
				ver = defaultMCPClientVersion
			}
			sc.EditingMode = editingModeYoothemeMCP
			sc.MCP = &MCPConfig{
				Endpoint:      s.Tool.Endpoint,
				TokenEnvVar:   s.Tool.TokenEnv,
				ClientVersion: ver,
				HostHeader:    s.Tool.HostHeader,
			}
		case "emdash":
			sc.EditingMode = editingModeEmdash
			sc.Emdash = &EmdashConfig{
				Endpoint:    s.Tool.Endpoint,
				TokenEnvVar: s.Tool.TokenEnv,
				RepoPath:    s.Tool.RepoPath,
				Skill:       s.Tool.Skill,
			}
		case "filesystem":
			sc.EditingMode = editingModeFilesystem
			sc.Workspace = s.Tool.Workspace
		}
		m[s.SiteID] = sc
	}
	return m
}

// effectiveSites intersects the locally-configured sites with the
// Relay-authoritative grant list. Sites the Relay did NOT grant are dropped (the
// Adapter never self-authorizes); granted sites with no local tool config are
// reported so the caller can fail safely rather than guess.
func effectiveSites(local map[string]SiteConfig, granted []string) (map[string]SiteConfig, []string) {
	eff := make(map[string]SiteConfig, len(granted))
	var missing []string
	for _, id := range granted {
		if cfg, ok := local[id]; ok {
			eff[id] = cfg
		} else {
			missing = append(missing, id)
		}
	}
	return eff, missing
}
