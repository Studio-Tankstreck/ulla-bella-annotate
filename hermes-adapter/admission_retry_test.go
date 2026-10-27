package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

// failingTransport fails the first N requests with a network error, standing in
// for a connection break where the POST never (visibly) reaches Hermes.
type failingTransport struct {
	failures int
	inner    http.RoundTripper
	calls    int
}

func (t *failingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.calls++
	if t.failures > 0 {
		t.failures--
		return nil, fmt.Errorf("connection reset by peer")
	}
	return t.inner.RoundTrip(req)
}

func TestSubmitRunRetriesOnUncertain5xx(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.failNextAdmit = 1
	id, err := h.submitRun("prompt", "ub-key-5xx")
	if err != nil {
		t.Fatalf("submit should recover after an uncertain 5xx: %v", err)
	}
	if id == "" {
		t.Fatal("want a run_id")
	}
	if f.admits != 2 {
		t.Fatalf("admits = %d, want 2 (one dropped, one replayed)", f.admits)
	}
}

func TestSubmitRunRecoversSameRunAfterAdmitThenDrop(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.failNextAdmit = 1
	id, err := h.submitRun("prompt", "ub-key-drop")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if id == "" {
		t.Fatal("want a run_id")
	}
	if f.admits != 2 {
		t.Fatalf("admits = %d, want 2", f.admits)
	}
	if len(f.idem) != 1 {
		t.Fatalf("idem reservations = %d, want exactly 1 (single run)", len(f.idem))
	}
	if len(f.lastKeys) != 2 || f.lastKeys[0] != "ub-key-drop" || f.lastKeys[1] != "ub-key-drop" {
		t.Fatalf("lastKeys = %v, want the same key on both attempts", f.lastKeys)
	}
	if len(f.lastBodies) != 2 || f.lastBodies[0] != f.lastBodies[1] {
		t.Fatalf("admission payload must be identical across attempts")
	}
}

func TestSubmitRunDoesNotRetryOnConflict(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	f.admitStatus = http.StatusConflict
	if _, err := h.submitRun("prompt", "ub-key-conflict"); err == nil {
		t.Fatal("want an error for a 409 conflict")
	}
	if f.admits != 1 {
		t.Fatalf("admits = %d, want 1 (409 must never be retried)", f.admits)
	}
}

func TestSubmitRunNetworkErrorRetries(t *testing.T) {
	h, f := newRunsExecutor(t, doneOutput)
	tr := &failingTransport{failures: 1, inner: h.Client.Transport}
	h.Client = &http.Client{Transport: tr}
	h.AdmissionRetryBackoff = time.Millisecond
	id, err := h.submitRun("prompt", "ub-key-net")
	if err != nil {
		t.Fatalf("submit should recover after a network error: %v", err)
	}
	if id == "" {
		t.Fatal("want a run_id")
	}
	if tr.calls != 2 {
		t.Fatalf("transport calls = %d, want 2 (one error, one success)", tr.calls)
	}
	if f.admits != 1 {
		t.Fatalf("admits = %d, want 1 (server reached only on the successful attempt)", f.admits)
	}
}

func TestAdmissionExpiredNearBoundary(t *testing.T) {
	near := RunRecord{AttemptedAt: time.Now().UTC().Add(-22 * time.Hour).Format(time.RFC3339)}
	if admissionExpired(near) {
		t.Fatal("a 22h-old admission is within the 23h grace and must not be expired")
	}
}
