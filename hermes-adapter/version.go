package main

import "fmt"

// Build metadata, injected at build time via -ldflags (see
// scripts/install-adapter.sh and docs/ADAPTER_INSTALL.md). The defaults keep
// `--version` useful even when built plainly: it must never require a running
// Relay or Hermes.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func printVersion() {
	fmt.Printf("ulla-bella-adapter %s (commit %s, built %s)\n", version, commit, buildDate)
}
