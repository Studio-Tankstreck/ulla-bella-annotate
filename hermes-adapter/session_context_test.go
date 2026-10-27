package main

// Tests for the job-wide session description reaching the ACTUAL Hermes prompt
// (etapp 2, point 2). The description must be written once, clearly separated
// from the per-annotation tasks, in every editing mode — and jobs without it
// (older jobs) must produce exactly the prompt they produced before.

import (
	"strings"
	"testing"

	"ullabella-annotate/internal/proto"
)

func sessionContextSiteContext(t *testing.T, editingMode string, description string) SiteContext {
	t.Helper()
	jb := proto.Job{
		JobID:     "job_session_1",
		SiteID:    "site_ctx",
		DeviceID:  "dev_ctx",
		CreatedAt: "2026-10-26T00:00:00Z",
		Annotations: []proto.Annotation{
			{
				AnnotationID: "ann_one",
				Instruction:  "Change the main heading to Our Services",
				Target: proto.Target{
					URL:         "https://example.test/tjanster",
					ElementType: "h1",
					VisibleText: "Tjänster",
				},
			},
			{
				AnnotationID: "ann_two",
				Instruction:  "Change the pricing heading to Pricing",
				Target: proto.Target{
					URL:         "https://example.test/tjanster",
					ElementType: "h2",
					VisibleText: "Priser",
				},
			},
		},
	}
	if description != "" {
		jb.Context = &proto.JobContext{Session: description}
	}
	cfg := SiteConfig{
		SiteID:      "site_ctx",
		Origin:      "https://example.test",
		Workspace:   "/tmp/ulla-bella-test-site",
		EditingMode: editingMode,
		MCP: &MCPConfig{
			Endpoint:      "http://127.0.0.1:18780/api/index.php/v1/yt-builder-mcp",
			TokenEnvVar:   "YTB_MCP_TOKEN",
			ClientVersion: "2.3.1",
		},
		Emdash: &EmdashConfig{
			Endpoint:    "https://infraverket.eu/_emdash/api",
			TokenEnvVar: "EMDASH_TOKEN",
			RepoPath:    "/srv/infraverket",
			Skill:       "infraverket",
		},
	}
	targets := make([]ResolvedTarget, 0, len(jb.Annotations))
	for _, ann := range jb.Annotations {
		targets = append(targets, ResolvedTarget{Annotation: ann, FilePath: "/tmp/ulla-bella-test-site/index.html"})
	}
	return SiteContext{Config: cfg, Job: jb, Targets: targets}
}

func TestSessionDescriptionReachesEveryPromptMode(t *testing.T) {
	t.Setenv("YTB_MCP_TOKEN", "tok_secret")
	t.Setenv("EMDASH_TOKEN", "tok_secret")
	const desc = "Rework the services page for the autumn campaign; keep the tone short and factual."
	h := &HermesExecutor{}

	for _, mode := range []string{editingModeFilesystem, editingModeYoothemeMCP, editingModeEmdash} {
		prompt := h.buildTask(sessionContextSiteContext(t, mode, desc))

		if got := strings.Count(prompt, desc); got != 1 {
			t.Fatalf("%s: session description must appear exactly once, got %d\n---\n%s", mode, got, prompt)
		}
		if !strings.Contains(prompt, "Session description") {
			t.Fatalf("%s: prompt is missing the session-description heading\n---\n%s", mode, prompt)
		}
		// It is context, not a task: it must come before the first annotation.
		descAt := strings.Index(prompt, desc)
		firstAnnAt := strings.Index(prompt, "ann_one")
		if descAt < 0 || firstAnnAt < 0 || descAt > firstAnnAt {
			t.Fatalf("%s: the session description must precede the annotations\n---\n%s", mode, prompt)
		}
		// Both annotations stay individual, with their stable ids and targets.
		for _, want := range []string{
			"Task 1 (annotationId: ann_one)",
			"Task 2 (annotationId: ann_two)",
			"Change the main heading to Our Services",
			"Change the pricing heading to Pricing",
			"https://example.test/tjanster",
		} {
			if !strings.Contains(prompt, want) {
				t.Fatalf("%s: prompt is missing %q\n---\n%s", mode, want, prompt)
			}
		}
		// The description must not be duplicated into the annotation blocks.
		if got := strings.Count(prompt, desc); got > 1 {
			t.Fatalf("%s: the session description leaked into the annotation blocks", mode)
		}
	}
}

func TestJobWithoutSessionDescriptionKeepsTheOldPrompt(t *testing.T) {
	t.Setenv("YTB_MCP_TOKEN", "tok_secret")
	t.Setenv("EMDASH_TOKEN", "tok_secret")
	h := &HermesExecutor{}

	for _, mode := range []string{editingModeFilesystem, editingModeYoothemeMCP, editingModeEmdash} {
		prompt := h.buildTask(sessionContextSiteContext(t, mode, ""))
		if strings.Contains(prompt, "Session description") {
			t.Fatalf("%s: an older job without context must not get a session-description section\n---\n%s", mode, prompt)
		}
		if !strings.Contains(prompt, "Change the main heading to Our Services") {
			t.Fatalf("%s: the annotations themselves must still be in the prompt", mode)
		}
	}
}

func TestBlankSessionDescriptionIsOmitted(t *testing.T) {
	h := &HermesExecutor{}
	prompt := h.buildTask(sessionContextSiteContext(t, editingModeFilesystem, "   \n\t  "))
	if strings.Contains(prompt, "Session description") {
		t.Fatalf("a whitespace-only description must be omitted:\n%s", prompt)
	}
}

func TestSingleAnnotationPromptStillCarriesItsID(t *testing.T) {
	h := &HermesExecutor{}
	ctx := sessionContextSiteContext(t, editingModeFilesystem, "One change only")
	ctx.Targets = ctx.Targets[:1]
	prompt := h.buildTask(ctx)
	if !strings.Contains(prompt, "Annotation (annotationId: ann_one)") {
		t.Fatalf("a single-annotation prompt must still name the stable annotationId:\n%s", prompt)
	}
	if !strings.Contains(prompt, "One change only") {
		t.Fatalf("a single-annotation prompt must carry the session description:\n%s", prompt)
	}
}

func TestJobContextRidesThroughProtocolJSON(t *testing.T) {
	jb := proto.Job{
		JobID:     "job_1",
		SiteID:    "site_1",
		DeviceID:  "dev_1",
		CreatedAt: "2026-10-26T00:00:00Z",
		Context:   &proto.JobContext{Session: "Autumn campaign copy"},
		Annotations: []proto.Annotation{{
			AnnotationID: "ann_1",
			Instruction:  "Change the heading",
			Target:       proto.Target{URL: "https://example.test/"},
		}},
	}
	env := proto.NewEnvelope(proto.MsgTypeJob, jb)
	if !strings.Contains(string(env.Payload), `"context":{"session":"Autumn campaign copy"}`) {
		t.Fatalf("the wire payload must carry the job context: %s", env.Payload)
	}

	// And a job without context must not grow a context field on the wire.
	jb.Context = nil
	env = proto.NewEnvelope(proto.MsgTypeJob, jb)
	if strings.Contains(string(env.Payload), `"context"`) {
		t.Fatalf("a job without context must not serialize one: %s", env.Payload)
	}
}
