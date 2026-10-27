package main

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"ullabella-annotate/internal/proto"
)

// Editing modes for a SiteConfig. A site is edited either through the local
// filesystem test workspace or through the YOOtheme MCP (CMS-backed).
const (
	editingModeFilesystem  = "filesystem-test"
	editingModeYoothemeMCP = "yootheme-mcp"
	editingModeEmdash      = "emdash"
)

// SiteConfig is the agent-side authority for one logical Site. It binds a
// protocol Site/origin to a concrete local test workspace (filesystem-test) or
// to YOOtheme MCP access (yootheme-mcp). It never travels to Chrome and is
// never part of Protocol V1.
type SiteConfig struct {
	SiteID      string        `json:"siteId"`
	Origin      string        `json:"origin"`
	Workspace   string        `json:"workspace"`
	EditingMode string        `json:"editingMode"`
	MCP         *MCPConfig    `json:"mcp,omitempty"`
	Emdash      *EmdashConfig `json:"emdash,omitempty"`
}

// MCPConfig is the agent-side YOOtheme MCP access configuration for a
// CMS-backed site. The Bearer token is referenced by environment variable name
// (TokenEnvVar), never embedded, so the secret stays in the adapter process
// environment and is never committed, logged, or sent to Chrome.
type MCPConfig struct {
	// Endpoint is the MCP JSON-RPC base URL (no trailing "/mcp"), reachable
	// from both the adapter and Hermes.
	Endpoint string `json:"endpoint"`
	// TokenEnvVar names the environment variable holding the Bearer token.
	TokenEnvVar string `json:"tokenEnvVar"`
	// ClientVersion is the value for the X-Ytb-Mcp-Client compat-floor header.
	ClientVersion string `json:"clientVersion"`
	// HostHeader, when set, is sent as the HTTP Host header on MCP requests.
	// It is required when the endpoint is reached via a tunnel or port that
	// does not carry the site's real hostname (Joomla resolves "this site"
	// from the request host).
	HostHeader string `json:"hostHeader,omitempty"`
}

// EmdashConfig is the agent-side EmDash access configuration for a CMS-backed
// site whose content lives in EmDash (e.g. infraverket.eu). Content edits go
// through the EmDash REST API; code/layout edits go through the local repo +
// git/Plesk deploy. The durable "how" lives in the site's Hermes skill
// (Skill). The Bearer token is referenced by environment variable name, never
// embedded.
type EmdashConfig struct {
	// Endpoint is the EmDash REST API base URL (e.g.
	// https://infraverket.eu/_emdash/api), reachable from the adapter/Hermes.
	Endpoint string `json:"endpoint"`
	// TokenEnvVar names the environment variable holding the EmDash Bearer token.
	TokenEnvVar string `json:"tokenEnvVar"`
	// RepoPath is the local checkout of the site source, for code/layout edits
	// + git/Plesk deploy. Empty means content-only editing.
	RepoPath string `json:"repoPath,omitempty"`
	// Skill names the Hermes skill that carries the durable EmDash + deploy
	// procedure (default "infraverket").
	Skill string `json:"skill,omitempty"`
}

// devSites is the static development mapping. Task 06/07 use the filesystem
// test site; Task 09B adds the Joomla/YOOtheme CMS pilot. The workspace and the
// MCP endpoint are overridable at deploy time.
func devSites() map[string]SiteConfig {
	joomlaOrigin := proto.EnvOr("UB_JOOMLA_ORIGIN", "https://joomla.example.test")
	return map[string]SiteConfig{
		"site_01j7x9k2m": {
			SiteID:      "site_01j7x9k2m",
			Origin:      proto.EnvOr("SITE_ORIGIN", "https://example.test"),
			Workspace:   proto.EnvOr("ADAPTER_WORKSPACE", "/srv/ulla-bella-sites/example.test"),
			EditingMode: editingModeFilesystem,
		},
		"site_ub_joomla": {
			SiteID:      "site_ub_joomla",
			Origin:      joomlaOrigin,
			Workspace:   "", // CMS-backed; no local workspace file
			EditingMode: editingModeYoothemeMCP,
			MCP: &MCPConfig{
				Endpoint:      proto.EnvOr("YTB_MCP_ENDPOINT", "http://127.0.0.1:18780/api/index.php/v1/yt-builder-mcp"),
				TokenEnvVar:   "YTB_MCP_TOKEN",
				ClientVersion: "2.3.1",
				HostHeader:    hostOf(joomlaOrigin),
			},
		},
	}
}

// hostOf returns the host[:port] of a URL, used to set the Host header when
// the MCP endpoint is reached via a tunnel that hides the site hostname.
func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Host
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

// resolveWorkspaceFile maps one annotation URL to a concrete file inside the
// configured workspace. This is ONE controlled mapping, not a general router:
// a URL path naming a directory maps to that directory's index.html.
//
// The caller is expected to have already verified sameOrigin. The result is
// guaranteed to be a clean, absolute path inside the workspace.
func resolveWorkspaceFile(cfg SiteConfig, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}

	rel := strings.TrimPrefix(u.Path, "/")
	if rel == "" {
		rel = "index.html"
	} else if strings.HasSuffix(rel, "/") || filepath.Ext(rel) == "" {
		rel = filepath.Join(rel, "index.html")
	}

	wsAbs, err := filepath.Abs(cfg.Workspace)
	if err != nil {
		return "", err
	}
	fullAbs, err := filepath.Abs(filepath.Join(wsAbs, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if fullAbs != wsAbs && !strings.HasPrefix(fullAbs, wsAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("resolved path escapes configured workspace")
	}
	return fullAbs, nil
}
