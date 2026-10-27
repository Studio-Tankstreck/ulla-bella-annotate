package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// buildEmdashTask constructs the execution task for an EmDash-backed site
// (e.g. infraverket.eu). It hands Hermes the EmDash REST API endpoint + auth
// (agent-side only, never sent to Chrome) and, when configured, the local repo
// path for code/layout edits deployed via git/Plesk. The durable "how" lives in
// the site's Hermes skill (EmdashConfig.Skill); the prompt carries only the
// site-specific runtime facts and the annotation. Requires a machine-readable
// outcome.
func (h *HermesExecutor) buildEmdashTask(ctx SiteContext) string {
	em := ctx.Config.Emdash
	skill := em.Skill
	if skill == "" {
		skill = "infraverket"
	}
	var b strings.Builder
	b.WriteString("You are handling one Ulla-Bella website editing request against an EmDash site.\n\n")
	b.WriteString("Allowed site:\n" + ctx.Config.Origin + "\n\n")
	b.WriteString("Load and follow your \"" + skill + "\" skill for the exact EmDash editing and publishing procedure.\n\n")
	b.WriteString("EmDash REST API base URL:\n" + em.Endpoint + "\n")
	b.WriteString("Auth: every request must carry `Authorization: Bearer " + os.Getenv(em.TokenEnvVar) + "` and the header `X-EmDash-Request: 1`.\n")
	b.WriteString("Treat the token as secret: never print it, log it, or write it into any file.\n\n")
	if em.RepoPath != "" {
		b.WriteString("For code/layout changes (components, styles, page structure — NOT text/content), edit the site source in this local repo and deploy it with the git/Plesk procedure from your skill:\n")
		b.WriteString("Repo path: " + em.RepoPath + "\n\n")
	}
	b.WriteString("Decide which path applies: if the target element is rendered from EmDash content (headings, body text, blocks, menus), edit it through the EmDash REST API (content update with its _rev). Only if it is a code/layout/component change, edit the repo and deploy.\n\n")

	writeSessionContext(&b, ctx.Job)
	writeAnnotationHeading(&b, len(ctx.Targets))

	for i, t := range ctx.Targets {
		ann := t.Annotation
		annotationHeading(&b, i, len(ctx.Targets), ann.AnnotationID)
		b.WriteString("Target page: " + ann.Target.URL + "\n")
		if ann.Target.ElementType != "" {
			b.WriteString("Element type: " + ann.Target.ElementType + "\n")
		}
		if ann.Target.VisibleText != "" {
			b.WriteString("Visible text: " + strconv.Quote(ann.Target.VisibleText) + "\n")
		}
		if ann.Target.Selector != "" {
			b.WriteString("Selector hint: " + ann.Target.Selector + "\n")
		}
		if ann.Target.DomPath != "" {
			b.WriteString("DOM path hint: " + ann.Target.DomPath + "\n")
		}
		if s, ok := ann.Context["nearbyText"].(string); ok && s != "" {
			b.WriteString("Nearby context: " + s + "\n")
		}
		b.WriteString("Requested change: " + ann.Instruction + "\n\n")
	}

	b.WriteString("Resolve the element from the annotation context. Change ONLY the intended element and no other. Then read the result back and confirm the intended element now contains the requested new content.\n\n")
	b.WriteString("If you cannot resolve the element, or you cannot verify the change, do not fabricate success — report an error.\n\n")
	writeResponseFormat(&b, len(ctx.Targets) > 1)
	return b.String()
}

// emdashPostcondition is the deterministic defense-in-depth check for the EmDash
// slice: after Hermes reports done, fetch the live page and confirm the previous
// visible text no longer appears. It mirrors the MCP/filesystem checks and is NOT
// a replacement for Hermes's own verification.
func emdashPostcondition(ctx SiteContext) (code, msg string, ok bool) {
	return emdashPostconditionTargets(ctx, ctx.Targets)
}

func emdashPostconditionTargets(ctx SiteContext, targets []ResolvedTarget) (code, msg string, ok bool) {
	for _, t := range targets {
		old := strings.TrimSpace(t.Annotation.Target.VisibleText)
		if old == "" {
			continue // nothing deterministic to check; trust Hermes
		}
		body, err := fetchPageText(t.Annotation.Target.URL)
		if err != nil {
			return "verification_failed", "postcondition: live fetch failed: " + err.Error(), false
		}
		if textContains(body, old) {
			return "verification_failed", "postcondition: the previous text still appears on the live page", false
		}
	}
	return "", "", true
}

// fetchPageText GETs a URL and returns the response body (capped at 4 MiB). It is
// used only by the EmDash postcondition read-back.
func fetchPageText(rawURL string) (string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// textContains reports whether the normalized (tag-stripped, whitespace-collapsed)
// page text contains the given normalized needle. A plain substring match would
// false-negative when markup splits the visible text (e.g. "Hej <strong>världen</strong>").
func textContains(html, needle string) bool {
	norm := func(s string) string {
		return strings.Join(strings.Fields(tagRE.ReplaceAllString(s, " ")), " ")
	}
	n := norm(needle)
	if n == "" {
		return false
	}
	return strings.Contains(norm(html), n)
}
