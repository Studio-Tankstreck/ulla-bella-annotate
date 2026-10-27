package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ullabella-annotate/internal/proto"
)

func canonicalJob() proto.Job {
	return proto.Job{
		JobID:    "job_test",
		SiteID:   "site_01j7x9k2m",
		DeviceID: "dev_01j7xa1b3",
		Annotations: []proto.Annotation{
			{
				AnnotationID: "ann_test",
				Instruction:  "Change this heading to Our Services",
				Target: proto.Target{
					URL:         "https://example.test/services",
					ElementType: "h1",
					VisibleText: "Tjänster",
				},
			},
		},
	}
}

// recordingExecutor counts calls so tests can assert Hermes was not invoked.
type recordingExecutor struct{ calls int }

func (r *recordingExecutor) Execute(SiteContext) Outcome {
	r.calls++
	return doneOutcome("ok")
}

func TestUnknownSite(t *testing.T) {
	rec := &recordingExecutor{}
	jb := canonicalJob()
	jb.SiteID = "site_unknown"
	res := handleJob(devSites(), rec, jb)
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "site_not_configured" {
		t.Fatalf("want site_not_configured, got %+v", res)
	}
	if rec.calls != 0 {
		t.Fatalf("executor invoked %d times for unknown site", rec.calls)
	}
}

func TestURLOutsideOrigin(t *testing.T) {
	rec := &recordingExecutor{}
	jb := canonicalJob()
	jb.Annotations[0].Target.URL = "https://evil.test/services"
	res := handleJob(devSites(), rec, jb)
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "url_out_of_origin" {
		t.Fatalf("want url_out_of_origin, got %+v", res)
	}
	if rec.calls != 0 {
		t.Fatalf("executor invoked for out-of-origin url")
	}
}

func TestPathEscapesWorkspace(t *testing.T) {
	rec := &recordingExecutor{}
	jb := canonicalJob()
	jb.Annotations[0].Target.URL = "https://example.test/../../outside.html"
	res := handleJob(devSites(), rec, jb)
	if res.Status != proto.StatusError || res.Error == nil || res.Error.Code != "path_out_of_workspace" {
		t.Fatalf("want path_out_of_workspace, got %+v", res)
	}
	if rec.calls != 0 {
		t.Fatalf("executor invoked for escaping path")
	}
}

func TestResolveWorkspaceFile(t *testing.T) {
	cfg := devSites()["site_01j7x9k2m"]
	cfg.Workspace = "/tmp/ub-ws"

	got, err := resolveWorkspaceFile(cfg, "https://example.test/services")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := filepath.Join("/tmp/ub-ws", "services", "index.html"); got != want {
		t.Fatalf("got %q want %q", got, want)
	}

	if got, _ = resolveWorkspaceFile(cfg, "https://example.test/"); got != filepath.Join("/tmp/ub-ws", "index.html") {
		t.Fatalf("root mapping: got %q", got)
	}

	if _, err := resolveWorkspaceFile(cfg, "https://example.test/../../../etc/passwd"); err == nil {
		t.Fatal("expected escape to be rejected")
	}
}

func TestStubExecutor(t *testing.T) {
	out := StubExecutor{}.Execute(SiteContext{})
	if out.Status != proto.StatusDone || out.Verification == nil || out.Verification.Status != "passed" {
		t.Fatalf("stub should return done, got %+v", out)
	}
}

// --- HermesExecutor tests (dependency-injected via the fakeRuns backend in
// runs_test.go) ---

// siteContext builds a SiteContext whose workspace is a temp dir containing a
// services/index.html with the given H1 text.
func siteContext(t *testing.T, h1 string) SiteContext {
	t.Helper()
	dir := t.TempDir()
	services := filepath.Join(dir, "services")
	if err := os.MkdirAll(services, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(services, "index.html"), []byte("<html><h1>"+h1+"</h1></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := devSites()["site_01j7x9k2m"]
	cfg.Workspace = dir
	jb := canonicalJob()
	path, err := resolveWorkspaceFile(cfg, jb.Annotations[0].Target.URL)
	if err != nil {
		t.Fatal(err)
	}
	return SiteContext{
		Config:  cfg,
		Job:     jb,
		Targets: []ResolvedTarget{{Annotation: jb.Annotations[0], FilePath: path}},
	}
}

func TestHermesDoneWithPassingPostcondition(t *testing.T) {
	h, _ := newRunsExecutor(t, doneOutput)
	out := h.Execute(siteContext(t, "Our Services"))
	if out.Status != proto.StatusDone {
		t.Fatalf("want done, got %+v", out)
	}
}

func TestHermesDoneButFileUnchanged(t *testing.T) {
	h, _ := newRunsExecutor(t, doneOutput)
	out := h.Execute(siteContext(t, "Tjänster"))
	if out.Status != proto.StatusError || out.ErrorCode != "verification_failed" {
		t.Fatalf("want verification_failed, got %+v", out)
	}
}

func TestHermesReportsError(t *testing.T) {
	body := `{"status":"error","error":{"code":"edit_failed","message":"cannot locate target"}}`
	h, _ := newRunsExecutor(t, body)
	out := h.Execute(siteContext(t, "Tjänster"))
	if out.Status != proto.StatusError || out.ErrorCode != "edit_failed" {
		t.Fatalf("want edit_failed, got %+v", out)
	}
}

func TestHermesUnavailable(t *testing.T) {
	h := &HermesExecutor{BaseURL: "http://127.0.0.1:1", APIKey: "test-key", Model: "hermes-agent", Client: &http.Client{Timeout: time.Second}, AdmissionRetryBackoff: time.Millisecond}
	out := h.Execute(siteContext(t, "Tjänster"))
	if out.Status != proto.StatusError || out.ErrorCode != "hermes_unavailable" {
		t.Fatalf("want hermes_unavailable, got %+v", out)
	}
}

func TestHermesMissingKey(t *testing.T) {
	h := &HermesExecutor{BaseURL: "http://127.0.0.1:1", APIKey: "", Model: "hermes-agent", Client: &http.Client{}}
	out := h.Execute(siteContext(t, "Tjänster"))
	if out.Status != proto.StatusError || out.ErrorCode != "hermes_unavailable" {
		t.Fatalf("want hermes_unavailable, got %+v", out)
	}
}

func TestParseHermesOutcome(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		status string
		code   string
	}{
		{"clean-done", `{"status":"done","summary":"s","verification":{"status":"passed","summary":"s"}}`, "done", ""},
		{"fenced-done", "```json\n{\"status\":\"done\",\"summary\":\"s\",\"verification\":{\"status\":\"passed\",\"summary\":\"s\"}}\n```", "done", ""},
		{"prose-around", "Here is the result: {\"status\":\"error\",\"error\":{\"code\":\"edit_failed\",\"message\":\"x\"}}", "error", "edit_failed"},
		{"done-no-verification", `{"status":"done","summary":"s"}`, "error", "verification_failed"},
		{"not-json", "Looks good!", "error", "hermes_outcome_unparseable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := parseHermesOutcome(c.in)
			if out.Status != c.status {
				t.Fatalf("status = %q want %q", out.Status, c.status)
			}
			if c.code != "" && out.ErrorCode != c.code {
				t.Fatalf("code = %q want %q", out.ErrorCode, c.code)
			}
		})
	}
}
