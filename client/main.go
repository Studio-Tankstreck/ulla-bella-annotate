package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"ullabella-annotate/internal/proto"
)

func main() {
	relayAddr := proto.EnvOr("RELAY_ADDR", "127.0.0.1:8787")
	fixture := proto.EnvOr("JOB_FIXTURE", "protocol/fixtures/example-job.json")
	// DEVICE_CREDENTIAL authenticates the client as a paired Device. Required
	// now that the Relay has no unauthenticated path.
	cred := os.Getenv("DEVICE_CREDENTIAL")
	if cred == "" {
		fatal("DEVICE_CREDENTIAL is required (pair a Device first)")
	}

	jobBytes, err := os.ReadFile(fixture)
	if err != nil {
		fatal("read fixture: %v", err)
	}
	base := "http://" + relayAddr

	resp, err := doAuth(http.MethodPost, base+"/v1/jobs", cred, jobBytes)
	if err != nil {
		fatal("post job: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	var env proto.Envelope
	if err := json.Unmarshal(body, &env); err != nil {
		fatal("response is not an envelope: %v", err)
	}
	var res proto.Result
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		fatal("response payload is not a result: %v", err)
	}
	if res.Status == proto.StatusError {
		if res.Error != nil {
			fatal("job rejected: %s: %s", res.Error.Code, res.Error.Message)
		}
		fatal("job rejected: unknown error")
	}
	if resp.StatusCode != http.StatusAccepted || res.Status != proto.StatusAccepted {
		fatal("expected accepted, got HTTP %d status=%q", resp.StatusCode, res.Status)
	}
	jobID := res.JobID
	fmt.Printf("accepted jobId=%s\n", jobID)

	deadline := time.Now().Add(clientTimeout())
	for {
		cur := poll(base, jobID, cred)
		switch cur.Status {
		case proto.StatusDone:
			if cur.Verification == nil || cur.Verification.Status != "passed" {
				fatal("done without passed verification: %+v", cur)
			}
			fmt.Printf("summary: %s\n", cur.Summary)
			fmt.Println("Done")
			return
		case proto.StatusError:
			if cur.Error != nil {
				fatal("job failed: %s: %s", cur.Error.Code, cur.Error.Message)
			}
			fatal("job failed: unknown error")
		}
		if time.Now().After(deadline) {
			fatal("timed out waiting for done; last status=%q", cur.Status)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// doAuth performs a request carrying a Bearer Device credential.
func doAuth(method, url, cred string, body []byte) (*http.Response, error) {
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cred)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultClient.Do(req)
}

// clientTimeout returns the poll deadline in seconds. Default 10s keeps Task 06
// behavior; the real-Hermes E2E sets CLIENT_TIMEOUT higher because Hermes's edit
// + verify can take a while.
func clientTimeout() time.Duration {
	secs := 10
	if v := os.Getenv("CLIENT_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			secs = n
		}
	}
	return time.Duration(secs) * time.Second
}

func poll(base, jobID, cred string) proto.Result {
	resp, err := doAuth(http.MethodGet, base+"/v1/jobs/"+jobID, cred, nil)
	if err != nil {
		fatal("poll: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var env proto.Envelope
	if err := json.Unmarshal(b, &env); err != nil {
		fatal("poll response is not an envelope: %v", err)
	}
	var res proto.Result
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		fatal("poll payload is not a result: %v", err)
	}
	return res
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "client: "+format+"\n", args...)
	os.Exit(1)
}
