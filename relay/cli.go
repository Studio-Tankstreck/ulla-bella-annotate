package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"ullabella-annotate/internal/proto"
	"ullabella-annotate/internal/store"
)

// isCLICommand reports whether os.Args[1] is an operator subcommand (as opposed
// to the default "serve" behavior).
func isCLICommand(cmd string) bool {
	switch cmd {
	case "site", "agent", "invite", "device":
		return true
	}
	return false
}

// runCLI is the minimal operator surface (Part 4). It opens the SQLite store —
// the same file the running Relay uses — so every command works live against a
// running Relay (WAL + busy_timeout make cross-process access safe). No web
// dashboard, no browser admin UI.
func runCLI(noun string, args []string) {
	st, err := store.Open(dbFile())
	if err != nil {
		fatalf("%s: %v\n", noun, err)
	}
	defer st.Close()

	if len(args) == 0 {
		cliUsage(noun)
		os.Exit(2)
	}
	verb := args[0]
	switch noun {
	case "site":
		runSiteCmd(st, verb, args[1:])
	case "agent":
		runAgentCmd(st, verb, args[1:])
	case "invite":
		runInviteCmd(st, verb, args[1:])
	case "device":
		runDeviceCmd(st, verb, args[1:])
	}
}

func cliUsage(noun string) {
	fmt.Fprintf(os.Stderr, "usage: relay %s <command> [args]\n", noun)
	fmt.Fprintf(os.Stderr, "       see docs/RELAY.md for the full operator CLI\n")
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

func runSiteCmd(st *store.Store, verb string, args []string) {
	switch verb {
	case "create":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: relay site create <siteId> --origin <url> --name <display>")
			os.Exit(2)
		}
		siteID := args[0]
		fs := flag.NewFlagSet("site create", flag.ExitOnError)
		origin := fs.String("origin", "", "canonical site origin URL (scheme://host)")
		name := fs.String("name", "", "human display name")
		_ = fs.Parse(args[1:])
		if *origin == "" || *name == "" {
			fmt.Fprintln(os.Stderr, "site create: --origin and --name are required")
			os.Exit(2)
		}
		site, err := st.CreateSite(siteID, *origin, *name)
		if err != nil {
			fatalf("site create: %v\n", err)
		}
		fmt.Printf("siteId:      %s\norigin:      %s\ndisplayName: %s\nenabled:     %v\n", site.SiteID, site.Origin, site.DisplayName, site.Enabled)
	case "list":
		sites, err := st.ListSites()
		if err != nil {
			fatalf("site list: %v\n", err)
		}
		fmt.Printf("%-20s %-8s %-40s %s\n", "siteId", "enabled", "origin", "displayName")
		for _, s := range sites {
			fmt.Printf("%-20s %-8v %-40s %s\n", s.SiteID, s.Enabled, s.Origin, s.DisplayName)
		}
	case "enable", "disable":
		if len(args) < 1 {
			fmt.Fprintf(os.Stderr, "usage: relay site %s <siteId>\n", verb)
			os.Exit(2)
		}
		if err := st.SetSiteEnabled(args[0], verb == "enable"); err != nil {
			fatalf("site %s: %v\n", verb, err)
		}
		fmt.Printf("site %s %sd\n", args[0], verb)
	default:
		fmt.Fprintf(os.Stderr, "unknown site command %q\n", verb)
		os.Exit(2)
	}
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

func runAgentCmd(st *store.Store, verb string, args []string) {
	switch verb {
	case "create":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: relay agent create <agentId> --name <display>")
			os.Exit(2)
		}
		agentID := args[0]
		fs := flag.NewFlagSet("agent create", flag.ExitOnError)
		name := fs.String("name", "", "human display name")
		_ = fs.Parse(args[1:])
		if *name == "" {
			fmt.Fprintln(os.Stderr, "agent create: --name is required")
			os.Exit(2)
		}
		ag, cred, err := st.CreateAgent(agentID, *name)
		if err != nil {
			fatalf("agent create: %v\n", err)
		}
		fmt.Printf("agentId:     %s\ndisplayName: %s\n", ag.AgentID, ag.DisplayName)
		// The raw credential is printed exactly once, here. It is never stored
		// in plaintext and must never be logged.
		fmt.Printf("credential:  %s   (store securely — shown once)\n", cred)
	case "list":
		agents, err := st.ListAgents()
		if err != nil {
			fatalf("agent list: %v\n", err)
		}
		fmt.Printf("%-20s %-8s %s\n", "agentId", "enabled", "displayName")
		for _, a := range agents {
			fmt.Printf("%-20s %-8v %s\n", a.AgentID, a.Enabled, a.DisplayName)
		}
	case "grant-site", "revoke-site":
		if len(args) < 2 {
			fmt.Fprintf(os.Stderr, "usage: relay agent %s <agentId> <siteId>\n", verb)
			os.Exit(2)
		}
		var err error
		if verb == "grant-site" {
			err = st.GrantSite(args[0], args[1])
		} else {
			err = st.RevokeSite(args[0], args[1])
		}
		if err != nil {
			fatalf("agent %s: %v\n", verb, err)
		}
		fmt.Printf("agent %s %s %s\n", args[0], verb, args[1])
	case "enable", "disable":
		if len(args) < 1 {
			fmt.Fprintf(os.Stderr, "usage: relay agent %s <agentId>\n", verb)
			os.Exit(2)
		}
		if err := st.SetAgentEnabled(args[0], verb == "enable"); err != nil {
			fatalf("agent %s: %v\n", verb, err)
		}
		fmt.Printf("agent %s %sd\n", args[0], verb)
	default:
		fmt.Fprintf(os.Stderr, "unknown agent command %q\n", verb)
		os.Exit(2)
	}
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

// runInviteCmd implements the operator invite subcommand:
//
//	relay invite create <siteId> [--ttl 24h] [--out .]
//	relay invite list
//
// Invite creation works while the Relay is running (it writes the shared SQLite
// store directly). The raw token is written to the .ullabella file but never
// printed to stdout/stderr.
func runInviteCmd(st *store.Store, verb string, args []string) {
	switch verb {
	case "create":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: relay invite create <siteId> [--ttl 24h] [--out .]")
			os.Exit(2)
		}
		siteID := args[0]
		fs := flag.NewFlagSet("invite create", flag.ExitOnError)
		ttl := fs.Duration("ttl", store.DefaultInviteTTL, "invite lifetime (Go duration, e.g. 24h)")
		outDir := fs.String("out", ".", "directory for the exported .ullabella file")
		_ = fs.Parse(args[1:])

		inv, token, err := st.CreateInvite(siteID, *ttl)
		if err != nil {
			fatalf("invite: %v\n", err)
		}
		site, ok := st.GetSite(siteID)
		if !ok {
			fatalf("invite: unknown site %q\n", siteID)
		}

		file := fmt.Sprintf("{\"format\":\"ulla-bella-site\",\"version\":\"1\",\"relayUrl\":%q,\"invite\":%q}\n",
			relayPublicURL(), token)
		name := filepath.Join(*outDir, safeFilename(site.DisplayName)+".ullabella")
		if err := os.WriteFile(name, []byte(file), 0o644); err != nil {
			fatalf("invite: write %s: %v\n", name, err)
		}

		// Safe metadata only — never the token or any credential.
		fmt.Printf("inviteId:    %s\n", inv.InviteID)
		fmt.Printf("siteId:      %s\n", site.SiteID)
		fmt.Printf("origin:      %s\n", site.Origin)
		fmt.Printf("displayName: %s\n", site.DisplayName)
		fmt.Printf("expiresAt:   %s\n", inv.ExpiresAt)
		fmt.Printf("file:        %s\n", name)
	case "list":
		invites, err := st.ListInvites()
		if err != nil {
			fatalf("invite list: %v\n", err)
		}
		fmt.Printf("%-20s %-24s %-20s %s\n", "inviteId", "siteId", "expiresAt", "status")
		for _, inv := range invites {
			status := "redeemed"
			if inv.RedeemedAt == "" {
				status = "open"
			}
			fmt.Printf("%-20s %-24s %-20s %s\n", inv.InviteID, inv.SiteID, inv.ExpiresAt, status)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown invite command %q\n", verb)
		os.Exit(2)
	}
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

func runDeviceCmd(st *store.Store, verb string, args []string) {
	switch verb {
	case "list":
		devs, err := st.ListDevices()
		if err != nil {
			fatalf("device list: %v\n", err)
		}
		fmt.Printf("%-20s %-8s %s\n", "deviceId", "revoked", "sites")
		for _, d := range devs {
			revoked := "no"
			if d.RevokedAt != "" {
				revoked = "yes"
			}
			fmt.Printf("%-20s %-8s %s\n", d.DeviceID, revoked, strings.Join(d.Sites, ","))
		}
	case "revoke":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: relay device revoke <deviceId>")
			os.Exit(2)
		}
		if err := st.RevokeDevice(args[0]); err != nil {
			fatalf("device revoke: %v\n", err)
		}
		fmt.Printf("device %s revoked\n", args[0])
	case "rotate":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: relay device rotate <deviceId>")
			os.Exit(2)
		}
		cred, err := st.RotateDevice(args[0])
		if err != nil {
			fatalf("device rotate: %v\n", err)
		}
		fmt.Printf("device %s rotated\n", args[0])
		// The new raw credential is printed exactly once, here.
		fmt.Printf("credential: %s   (store securely — shown once)\n", cred)
	default:
		fmt.Fprintf(os.Stderr, "unknown device command %q\n", verb)
		os.Exit(2)
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

func dbFile() string {
	return proto.EnvOr("RELAY_DB_FILE", "ulla-bella.db")
}

// relayPublicURL is the externally-reachable Relay URL written into the
// .ullabella file. Defaults to loopback for scripted runs; override for a LAN
// browser (e.g. RELAY_PUBLIC_URL=https://relay.example.com).
func relayPublicURL() string {
	return proto.EnvOr("RELAY_PUBLIC_URL", "http://127.0.0.1:8787")
}

func safeFilename(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		out = "site"
	}
	return out
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format, args...)
	os.Exit(1)
}
