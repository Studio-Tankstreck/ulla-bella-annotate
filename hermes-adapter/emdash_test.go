package main

import (
	"strings"
	"testing"

	"ullabella-annotate/internal/proto"
)

const emdashConfigYAML = `
relay:
  url: wss://relay.example.com/v1/ws
agent:
  id: agent_test
  credential_env: ULLABELLA_AGENT_CREDENTIAL
hermes:
  base_url: http://127.0.0.1:8642
  model: hermes-agent
  api_key_env: API_SERVER_KEY
sites:
  - site_id: site_infraverket
    origin: https://infraverket.eu
    tool:
      type: emdash
      endpoint: https://infraverket.eu/_emdash/api
      token_env: INFRAVERKET_EMDASH_TOKEN
      repo_path: /srv/infraverket
      skill: infraverket
`

func withEmdashSecrets(t *testing.T, f func()) {
	t.Helper()
	t.Setenv("ULLABELLA_AGENT_CREDENTIAL", "uba_test")
	t.Setenv("API_SERVER_KEY", "k_test")
	t.Setenv("INFRAVERKET_EMDASH_TOKEN", "emdash_test")
	f()
}

func TestConfigEmdashValid(t *testing.T) {
	withEmdashSecrets(t, func() {
		cfg := writeConfig(t, emdashConfigYAML)
		if errs := cfg.validate(); len(errs) != 0 {
			t.Fatalf("expected valid emdash config, got %v", errs)
		}
	})
}

func TestConfigEmdashMissingToken(t *testing.T) {
	t.Setenv("ULLABELLA_AGENT_CREDENTIAL", "c")
	t.Setenv("API_SERVER_KEY", "k")
	// INFRAVERKET_EMDASH_TOKEN intentionally NOT set
	cfg := writeConfig(t, emdashConfigYAML)
	if errs := cfg.validate(); !hasErrorContaining(errs, "EmDash token") {
		t.Fatalf("expected missing EmDash token error, got %v", errs)
	}
}

func TestSiteMapEmdash(t *testing.T) {
	withEmdashSecrets(t, func() {
		cfg := writeConfig(t, emdashConfigYAML)
		m := cfg.siteMap()
		sc, ok := m["site_infraverket"]
		if !ok {
			t.Fatal("site_infraverket missing from siteMap")
		}
		if sc.EditingMode != editingModeEmdash {
			t.Fatalf("editingMode = %q", sc.EditingMode)
		}
		if sc.Emdash == nil || sc.Emdash.Endpoint == "" || sc.Emdash.TokenEnvVar != "INFRAVERKET_EMDASH_TOKEN" || sc.Emdash.RepoPath == "" {
			t.Fatalf("Emdash config wrong: %+v", sc.Emdash)
		}
	})
}

func emdashSiteContext(t *testing.T) SiteContext {
	t.Helper()
	cfg := SiteConfig{
		SiteID:      "site_infraverket",
		Origin:      "https://infraverket.eu",
		EditingMode: editingModeEmdash,
		Emdash: &EmdashConfig{
			Endpoint:    "https://infraverket.eu/_emdash/api",
			TokenEnvVar: "INFRAVERKET_EMDASH_TOKEN",
			RepoPath:    "/srv/infraverket",
			Skill:       "infraverket",
		},
	}
	jb := proto.Job{
		JobID:    "job_emdash",
		SiteID:   "site_infraverket",
		DeviceID: "dev_test",
		Annotations: []proto.Annotation{
			{
				AnnotationID: "ann_test",
				Instruction:  "Change this heading to Våra tjänster",
				Target: proto.Target{
					URL:         "https://infraverket.eu/",
					ElementType: "h1",
					VisibleText: "Öppen infrastruktur.",
				},
			},
		},
	}
	return SiteContext{Config: cfg, Job: jb, Targets: []ResolvedTarget{{Annotation: jb.Annotations[0]}}}
}

func TestBuildEmdashTask(t *testing.T) {
	t.Setenv("INFRAVERKET_EMDASH_TOKEN", "tok_secret")
	prompt := (&HermesExecutor{}).buildEmdashTask(emdashSiteContext(t))
	for _, want := range []string{
		"https://infraverket.eu/_emdash/api",
		"Authorization: Bearer tok_secret",
		"X-EmDash-Request: 1",
		"/srv/infraverket",
		"infraverket",
		"Change this heading to Våra tjänster",
		`{"status":"done"`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("buildEmdashTask missing %q\n---\n%s", want, prompt)
		}
	}
}

func TestBuildEmdashTaskNoRepo(t *testing.T) {
	t.Setenv("INFRAVERKET_EMDASH_TOKEN", "tok_secret")
	ctx := emdashSiteContext(t)
	ctx.Config.Emdash.RepoPath = ""
	prompt := (&HermesExecutor{}).buildEmdashTask(ctx)
	if strings.Contains(prompt, "Repo path:") {
		t.Fatalf("repo path should be omitted when unset:\n%s", prompt)
	}
}

func TestHandleJobEmdashSkipsWorkspace(t *testing.T) {
	// An EmDash site has no local workspace; handleJob must not try to resolve a
	// workspace file and must reach the executor.
	rec := &recordingExecutor{}
	sites := map[string]SiteConfig{
		"site_infraverket": {
			SiteID:      "site_infraverket",
			Origin:      "https://infraverket.eu",
			EditingMode: editingModeEmdash,
			Emdash:      &EmdashConfig{Endpoint: "https://infraverket.eu/_emdash/api", TokenEnvVar: "INFRAVERKET_EMDASH_TOKEN"},
		},
	}
	t.Setenv("INFRAVERKET_EMDASH_TOKEN", "tok")
	jb := canonicalJob()
	jb.SiteID = "site_infraverket"
	jb.Annotations[0].Target.URL = "https://infraverket.eu/"
	res := handleJob(sites, rec, jb)
	if res.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", res)
	}
	if rec.calls != 1 {
		t.Fatalf("executor called %d times, want 1", rec.calls)
	}
}

func TestTextContains(t *testing.T) {
	if !textContains("<html><h1>Hej <strong>världen</strong></h1></html>", "Hej världen") {
		t.Fatal("tag-stripped match should succeed")
	}
	if textContains("<html><h1>Ny text</h1></html>", "Gammal text") {
		t.Fatal("absent text should not match")
	}
}
