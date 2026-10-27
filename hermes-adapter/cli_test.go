package main

import "testing"

func TestParseArgs(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantCfg string
		wantEnv string
		wantCmd string
	}{
		{"serve no flags", []string{}, defaultConfigPath, "", ""},
		{"flags before subcommand", []string{"--config", "/x.yaml", "--env-file", "/x.env", "validate"}, "/x.yaml", "/x.env", "validate"},
		{"flags after subcommand", []string{"validate", "--config", "/x.yaml", "--env-file", "/x.env"}, "/x.yaml", "/x.env", "validate"},
		{"doctor with config only", []string{"doctor", "--config", "/y.yaml"}, "/y.yaml", "", "doctor"},
		{"version dash", []string{"--version"}, defaultConfigPath, "", "--version"},
		{"help dash", []string{"-h"}, defaultConfigPath, "", "-h"},
		{"version word", []string{"version"}, defaultConfigPath, "", "version"},
	}
	for _, c := range cases {
		gotCfg, gotEnv, gotCmd, _ := parseArgs(c.args)
		if gotCfg != c.wantCfg || gotEnv != c.wantEnv || gotCmd != c.wantCmd {
			t.Errorf("%s: parseArgs(%v) = (cfg=%q, env=%q, cmd=%q), want (cfg=%q, env=%q, cmd=%q)",
				c.name, c.args, gotCfg, gotEnv, gotCmd, c.wantCfg, c.wantEnv, c.wantCmd)
		}
	}
}
