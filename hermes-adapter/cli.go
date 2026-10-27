package main

import (
	"bufio"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// parseArgs scans os.Args for the global flags (--config, --env-file) and
// returns the subcommand ("" means serve) plus any trailing args. Flags may
// appear before or after the subcommand (e.g. `validate --config PATH`).
func parseArgs(args []string) (configPath, envFile, cmd string, cmdArgs []string) {
	configPath = defaultConfigPath
	// First pass: extract --config/--env-file values wherever they appear.
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--config":
			if i+1 < len(args) {
				i++
				configPath = args[i]
			}
		case "--env-file":
			if i+1 < len(args) {
				i++
				envFile = args[i]
			}
		}
	}
	// Second pass: the subcommand is the first token that is not one of those
	// flags or their values. --version/--help are subcommands handled by main,
	// so they are not skipped here.
	for i := 0; i < len(args); i++ {
		if args[i] == "--config" || args[i] == "--env-file" {
			i++ // skip the flag's value
			continue
		}
		cmd = args[i]
		cmdArgs = args[i:]
		return
	}
	return
}

// loadEnvFile reads KEY=VALUE lines (the systemd EnvironmentFile format) into the
// process environment. Values are literal: no shell expansion, no quote
// stripping — matching systemd's own EnvironmentFile semantics.
func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return fmt.Errorf("%s:%d: not a KEY=VALUE line", path, lineNo)
		}
		key := strings.TrimSpace(line[:eq])
		val := line[eq+1:]
		if key == "" {
			return fmt.Errorf("%s:%d: empty key", path, lineNo)
		}
		if err := os.Setenv(key, val); err != nil {
			return fmt.Errorf("%s:%d: setenv: %w", path, lineNo, err)
		}
	}
	return sc.Err()
}

func formatErrors(errs []error) string {
	var b strings.Builder
	for _, e := range errs {
		fmt.Fprintf(&b, "  - %v\n", e)
	}
	return b.String()
}

func printUsage(w *os.File) {
	fmt.Fprintf(w, `usage: ulla-bella-adapter [--config PATH] [--env-file PATH] [command]

Commands:
  (none)      run the adapter service (connect outbound to Relay, serve Jobs)
  validate    check the config file and referenced secrets; exit non-zero on error
  doctor      run connectivity checks (Relay / Hermes / each Site MCP)
  version     print version, commit and build date

Flags:
  --config PATH    adapter config file (default %s)
  --env-file PATH  load KEY=VALUE secrets from a protected file first
`, defaultConfigPath)
}

// runValidate loads and validates the config, printing one line per problem and
// exiting non-zero if any exist. It never contacts or modifies any Site.
func runValidate(cfgPath string) int {
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "validate: %v\n", err)
		return 1
	}
	errs := cfg.validate()
	if len(errs) == 0 {
		fmt.Printf("config OK: %s (agent=%s, %d site(s))\n", cfgPath, cfg.Agent.ID, len(cfg.Sites))
		return 0
	}
	fmt.Fprintf(os.Stderr, "config invalid (%s):\n%s", cfgPath, formatErrors(errs))
	return 1
}

// credRef is one referenced secret (label + env var name).
type credRef struct{ label, name string }

// credentialRefs lists every secret the config references, for the doctor
// "credentials present" check. Only names are reported, never values.
func credentialRefs(cfg *Config) []credRef {
	refs := []credRef{
		{"Agent credential", cfg.Agent.CredentialEnv},
		{"Hermes API key", cfg.Hermes.APIKeyEnv},
	}
	for _, s := range cfg.Sites {
		if s.Tool.TokenEnv != "" {
			refs = append(refs, credRef{"Site " + s.SiteID + " token", s.Tool.TokenEnv})
		}
	}
	return refs
}

// relayHealthURL derives the Relay's HTTP health endpoint from its ws/wss URL.
func relayHealthURL(wsURL string) (string, bool) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return "", false
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	default:
		return "", false
	}
	u.Path = "/healthz"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), true
}

// httpGet is a liveness probe used only by doctor. It sends no credentials and
// performs no edits; a non-200 status is still a successful reachability probe.
func httpGet(rawURL string) (int, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// mcpHealthGet probes a YOOtheme MCP /health endpoint with the Accept header the
// MCP server requires (a bare GET returns 406 Not Acceptable).
func mcpHealthGet(rawURL, clientVersion string) (int, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	if clientVersion == "" {
		clientVersion = defaultMCPClientVersion
	}
	req.Header.Set("X-Ytb-Mcp-Client", clientVersion)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// runDoctor performs safe connectivity checks. It performs NO content edits and
// never prints credential values. Output is operator-friendly "X OK / ERROR".
func runDoctor(cfgPath string) int {
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "doctor: %v\n", err)
		return 1
	}

	rc := 0
	report := func(name, detail string, ok bool) {
		state := "OK"
		if !ok {
			state = "ERROR"
			rc = 1
		}
		if detail == "" {
			fmt.Printf("%-22s %s\n", name, state)
		} else {
			fmt.Printf("%-22s %s  (%s)\n", name, state, detail)
		}
	}

	// Relay
	if hurl, ok := relayHealthURL(cfg.Relay.URL); ok {
		code, err := httpGet(hurl)
		switch {
		case err != nil:
			report("Relay", "unreachable", false)
		case code == http.StatusOK:
			report("Relay", cfg.Relay.URL, true)
		default:
			report("Relay", fmt.Sprintf("HTTP %d", code), false)
		}
	} else {
		report("Relay", "malformed relay URL", false)
	}

	// Hermes (401 still means "up"; doctor does not authenticate)
	modelsURL := hermesOrigin(cfg.Hermes.BaseURL) + "/v1/models"
	if code, err := httpGet(modelsURL); err != nil {
		report("Hermes", "unreachable", false)
	} else if code == http.StatusOK || code == http.StatusUnauthorized {
		report("Hermes", cfg.Hermes.BaseURL, true)
	} else {
		report("Hermes", fmt.Sprintf("HTTP %d", code), false)
	}

	// Credentials present (names only)
	for _, c := range credentialRefs(cfg) {
		if c.name == "" {
			report(c.label, "not referenced in config", false)
		} else if os.Getenv(c.name) == "" {
			report(c.label, "env var "+c.name+" not set", false)
		} else {
			report(c.label, "present ("+c.name+")", true)
		}
	}

	// Sites
	for _, s := range cfg.Sites {
		switch s.Tool.Type {
		case "yootheme-mcp":
			name := "Site " + s.SiteID + " MCP"
			hurl := strings.TrimRight(s.Tool.Endpoint, "/") + "/health"
			if code, err := mcpHealthGet(hurl, s.Tool.ClientVersion); err != nil {
				report(name, "unreachable", false)
			} else if code == http.StatusOK {
				report(name, s.Tool.Endpoint, true)
			} else {
				report(name, fmt.Sprintf("HTTP %d", code), false)
			}
		case "emdash":
			// EmDash's openapi.json is auth-protected, so 401 still means "up".
			name := "Site " + s.SiteID + " EmDash"
			hurl := strings.TrimRight(s.Tool.Endpoint, "/") + "/openapi.json"
			if code, err := httpGet(hurl); err != nil {
				report(name, "unreachable", false)
			} else if code == http.StatusOK || code == http.StatusUnauthorized {
				report(name, s.Tool.Endpoint, true)
			} else {
				report(name, fmt.Sprintf("HTTP %d", code), false)
			}
		default:
			report("Site "+s.SiteID+" MCP", "unsupported tool type "+s.Tool.Type, false)
		}
	}

	return rc
}
