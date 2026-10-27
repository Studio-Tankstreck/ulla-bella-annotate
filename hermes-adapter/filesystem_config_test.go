package main

import "testing"

func TestConfigFilesystemSite(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML+`
  - site_id: site_fs
    origin: https://example.test
    tool:
      type: filesystem
      workspace: /tmp/ub-test-ws
`)
		if errs := cfg.validate(); len(errs) != 0 {
			t.Fatalf("expected valid filesystem site, got %v", errs)
		}
		m := cfg.siteMap()
		sc, ok := m["site_fs"]
		if !ok {
			t.Fatal("site_fs missing from siteMap")
		}
		if sc.EditingMode != editingModeFilesystem || sc.Workspace != "/tmp/ub-test-ws" {
			t.Fatalf("filesystem mapping wrong: %+v", sc)
		}
	})
}

func TestConfigFilesystemSiteRequiresWorkspace(t *testing.T) {
	withSecrets(t, func() {
		cfg := writeConfig(t, validConfigYAML+`
  - site_id: site_fs
    origin: https://example.test
    tool:
      type: filesystem
`)
		if errs := cfg.validate(); !hasErrorContaining(errs, "workspace is required") {
			t.Fatalf("expected workspace-required error, got %v", errs)
		}
	})
}
