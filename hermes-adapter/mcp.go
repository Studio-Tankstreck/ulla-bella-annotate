package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// buildMCPTask constructs the execution task for a CMS-backed (YOOtheme MCP)
// site. It hands Hermes everything needed to drive the YOOtheme MCP JSON-RPC
// API — endpoint, auth + compat headers, and the tool sequence — plus the
// annotation context, and requires a machine-readable outcome. The MCP endpoint
// and Bearer token stay agent-side (adapter -> Hermes) and are never sent to
// Chrome and never enter Protocol V1.
func (h *HermesExecutor) buildMCPTask(ctx SiteContext) string {
	mcp := ctx.Config.MCP
	var b strings.Builder
	b.WriteString("You are handling one Ulla-Bella website editing request against a YOOtheme CMS site.\n\n")
	b.WriteString("Allowed site:\n" + ctx.Config.Origin + "\n\n")

	b.WriteString("Edit the site through the YOOtheme MCP JSON-RPC 2.0 API over HTTP.\n")
	b.WriteString("MCP base URL:\n" + mcp.Endpoint + "\n")
	b.WriteString("Post every JSON-RPC request to:\n" + mcp.Endpoint + "/mcp\n\n")
	b.WriteString("Every request MUST carry these HTTP headers:\n")
	b.WriteString("  Content-Type: application/json\n")
	b.WriteString("  Accept: application/json, text/event-stream\n")
	b.WriteString("  Authorization: Bearer " + os.Getenv(mcp.TokenEnvVar) + "\n")
	b.WriteString("  X-Ytb-Mcp-Client: " + mcp.ClientVersion + "\n")
	if mcp.HostHeader != "" {
		b.WriteString("  Host: " + mcp.HostHeader + "\n")
	}
	b.WriteString("\n")

	b.WriteString("Request body shape (JSON-RPC 2.0):\n")
	b.WriteString(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}` + "\n\n")

	b.WriteString("Use these MCP tools to locate and edit the element:\n")
	b.WriteString("1. yootheme_builder_pages_resolve        {url}                              -> layout_id\n")
	b.WriteString("2. yootheme_builder_element_list         {layout_id}                        -> element paths/types/labels\n")
	b.WriteString("3. yootheme_builder_element_get          {layout_id, element_path}          -> element props\n")
	b.WriteString("4. yootheme_builder_get_etag             {layout_id}                        -> etag\n")
	b.WriteString("5. yootheme_builder_element_update_settings {layout_id, element_path, props, etag} -> new etag\n")
	b.WriteString("6. yootheme_builder_page_publish         {layout_id, etag}                  -> persist + flush caches\n\n")
	b.WriteString("To verify, read the builder state back with yootheme_builder_page_get_layout {layout_id} (full tree including each element's props) or yootheme_builder_element_get {layout_id, element_path}.\n\n")

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

	b.WriteString("Resolve the corresponding YOOtheme builder element from the annotation context above. Change ONLY the intended element and no other. Then read the builder state back through the MCP tools and confirm the intended element now contains the requested new text.\n\n")
	b.WriteString("If you cannot resolve the element, or you cannot verify the change, do not fabricate success — report an error.\n\n")
	writeResponseFormat(&b, len(ctx.Targets) > 1)
	return b.String()
}

// mcpPostcondition is the deterministic defense-in-depth check for the MCP
// slice: after Hermes reports done, independently query the builder state and
// confirm the previous visible text no longer appears as any element's content.
// It mirrors the filesystem H1 check and is NOT a replacement for Hermes's own
// verification.
func mcpPostcondition(ctx SiteContext) (code, msg string, ok bool) {
	return mcpPostconditionTargets(ctx, ctx.Targets)
}

func mcpPostconditionTargets(ctx SiteContext, targets []ResolvedTarget) (code, msg string, ok bool) {
	mcp := ctx.Config.MCP
	if mcp == nil {
		return "verification_failed", "postcondition: no MCP config for site", false
	}
	for _, t := range targets {
		old := strings.TrimSpace(t.Annotation.Target.VisibleText)
		if old == "" {
			continue // nothing deterministic to check; trust Hermes
		}
		content, err := mcpReadBackContent(mcp, t.Annotation.Target.URL)
		if err != nil {
			return "verification_failed", "postcondition: MCP read-back failed: " + err.Error(), false
		}
		for _, c := range content {
			if strings.TrimSpace(c) == old {
				return "verification_failed", "postcondition: an element still contains the previous text", false
			}
		}
	}
	return "", "", true
}

// mcpReadBackContent resolves the layout for a URL and returns every element's
// canonical text (props.content) as a flat list, for postcondition checking.
func mcpReadBackContent(mcp *MCPConfig, pageURL string) ([]string, error) {
	resolve, err := mcpCall(mcp, "yootheme_builder_pages_resolve", map[string]any{"url": pageURL})
	if err != nil {
		return nil, err
	}
	layoutID, _ := resolve["layout_id"].(string)
	if layoutID == "" {
		return nil, fmt.Errorf("MCP could not resolve a layout for the page")
	}
	layout, err := mcpCall(mcp, "yootheme_builder_page_get_layout", map[string]any{"layout_id": layoutID})
	if err != nil {
		return nil, err
	}
	var out []string
	collectContent(layout["layout"], &out)
	return out, nil
}

// collectContent walks a builder layout node (type/props/children) and appends
// every props.content string it finds.
func collectContent(node any, out *[]string) {
	switch v := node.(type) {
	case map[string]any:
		if props, ok := v["props"].(map[string]any); ok {
			if s, ok := props["content"].(string); ok && strings.TrimSpace(s) != "" {
				*out = append(*out, s)
			}
		}
		if children, ok := v["children"].([]any); ok {
			for _, c := range children {
				collectContent(c, out)
			}
		}
	case []any:
		for _, c := range v {
			collectContent(c, out)
		}
	}
}

// mcpCall issues one JSON-RPC 2.0 tools/call to the YOOtheme MCP endpoint and
// returns the result's structuredContent (or the parsed text content).
func mcpCall(mcp *MCPConfig, tool string, args map[string]any) (map[string]any, error) {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": args},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, mcp.Endpoint+"/mcp", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+os.Getenv(mcp.TokenEnvVar))
	req.Header.Set("X-Ytb-Mcp-Client", mcp.ClientVersion)
	if mcp.HostHeader != "" {
		req.Host = mcp.HostHeader
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MCP HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	var rpc struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result *struct {
			StructuredContent map[string]any `json:"structuredContent"`
			Content           []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(respBody, &rpc); err != nil {
		return nil, fmt.Errorf("MCP returned malformed JSON: %w", err)
	}
	if rpc.Error != nil {
		return nil, fmt.Errorf("MCP error: %s", rpc.Error.Message)
	}
	if rpc.Result == nil {
		return nil, fmt.Errorf("MCP returned no result")
	}
	if rpc.Result.StructuredContent != nil {
		return rpc.Result.StructuredContent, nil
	}
	if len(rpc.Result.Content) > 0 && rpc.Result.Content[0].Text != "" {
		var sc map[string]any
		if err := json.Unmarshal([]byte(rpc.Result.Content[0].Text), &sc); err == nil {
			return sc, nil
		}
		return map[string]any{"text": rpc.Result.Content[0].Text}, nil
	}
	return nil, fmt.Errorf("MCP result has no structured content")
}
