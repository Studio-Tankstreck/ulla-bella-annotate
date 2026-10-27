// Package main — durable job→run persistence for the Hermes Adapter.
//
// The Adapter is otherwise stateless (the Relay owns job state). Task 4A adds
// the one piece of adapter-side durability the durable-run model requires: a
// mapping from the Ulla-Bella jobId to the Hermes run_id, plus the raw Job
// payload needed to reconstruct the site context for recovery. This lets the
// Adapter resume polling an in-flight run after a restart instead of silently
// losing (or re-running) it.
//
// Safety invariants:
//
//   - EnsurePending MUST run before the Adapter sends its "working" delivery
//     ack, so a crash at any point after receipt leaves a durable record to
//     resume from. The record is inserted idempotently (INSERT ... ON
//     CONFLICT DO NOTHING); the Relay's own jobId/payload dedup means the
//     Adapter never sees the same Job twice.
//   - Only jobId, the raw Job payload, the run_id, and the terminal Result are
//     stored. No credentials or secrets ever reach this file.
//   - Admission is two-phase: MarkAdmissionInFlight records "admission was
//     attempted" BEFORE the HTTP submit, so the state machine distinguishes a
//     provably-unsent job ("received") from one whose admission outcome is
//     unknown ("admission_in_flight"). A lost run_id is recovered by re-admitting
//     with the same Idempotency-Key — never a duplicate — but only while the
//     idempotency guarantee is still valid (see reconcile's grace window).
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver; registers "sqlite"

	"ullabella-annotate/internal/proto"
)

// Run-record lifecycle states. Terminal states mirror the V1 result statuses so
// a record is only re-delivered when it has a final result.
const (
	// runReceived: job persisted, admission never attempted — provably unsent.
	// Safe to re-admit at any age (the first run is still the only run).
	runReceived = "received"
	// runAdmissionInFlight: submitRun was attempted but the run_id was not yet
	// persisted. The admission outcome is UNKNOWN; re-admission is safe only
	// while the Hermes idempotency reservation is valid (see admission grace).
	runAdmissionInFlight = "admission_in_flight"
	// runRunning: run_id persisted; Hermes run in flight. Recovered by polling
	// the persisted run_id, never by re-admitting.
	runRunning = "running"
)

// RunRecord is one persisted job→run mapping.
type RunRecord struct {
	JobID       string
	SiteID      string
	Payload     []byte // raw Job JSON (for site-context reconstruction on recovery)
	RunID       string // empty until the run is admitted
	Status      string // received | admission_in_flight | running | done | error
	AttemptedAt string // RFC3339 time admission was first attempted (admission_in_flight)
	Result      []byte // terminal Result envelope JSON (for re-delivery)
}

// RunStore is the Adapter's SQLite-backed run mapping. It uses the same pure-Go
// driver as the Relay (modernc.org/sqlite) so no CGO is required.
type RunStore struct {
	db *sql.DB
}

// OpenRunStore opens (creating if necessary) the run store at path and applies
// the schema.
func OpenRunStore(path string) (*RunStore, error) {
	dsn := "file:" + path +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open run store: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS runs (
		job_id       TEXT PRIMARY KEY,
		site_id      TEXT NOT NULL,
		payload      TEXT NOT NULL,
		run_id       TEXT NOT NULL DEFAULT '',
		status       TEXT NOT NULL,
		result       TEXT NOT NULL DEFAULT '',
		attempted_at TEXT NOT NULL DEFAULT '',
		created_at   TEXT NOT NULL,
		updated_at   TEXT NOT NULL
	)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create runs table: %w", err)
	}
	return &RunStore{db: db}, nil
}

// Close releases the underlying connection.
func (s *RunStore) Close() error { return s.db.Close() }

// EnsurePending records a Job before execution begins so a crash can be
// recovered. Idempotent: if the job is already recorded (any status), the
// existing row is left untouched.
func (s *RunStore) EnsurePending(job proto.Job) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	now := nowUTC()
	if _, err := s.db.Exec(`INSERT INTO runs (job_id, site_id, payload, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(job_id) DO NOTHING`,
		job.JobID, job.SiteID, string(payload), runReceived, now, now); err != nil {
		return fmt.Errorf("insert received run: %w", err)
	}
	return nil
}

// MarkAdmissionInFlight records that admission is about to be (or was)
// attempted, moving a "received" record to "admission_in_flight". It is the
// gate BEFORE submitRun, so a crash between admission and run_id persistence
// leaves an "admission_in_flight" record rather than a misleading "received".
// The first call stamps attempted_at; later calls (re-admission within the
// grace window) preserve the original stamp so the grace clock is never reset.
func (s *RunStore) MarkAdmissionInFlight(jobID string) error {
	res, err := s.db.Exec(`UPDATE runs
		SET status = ?, attempted_at = COALESCE(NULLIF(attempted_at, ''), ?), updated_at = ?
		WHERE job_id = ? AND status IN ('received','admission_in_flight')`,
		runAdmissionInFlight, nowUTC(), nowUTC(), jobID)
	if err != nil {
		return fmt.Errorf("mark admission in flight: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return fmt.Errorf("job %s not in a re-admittable state", jobID)
	}
	return nil
}

// SetRunID records the Hermes run_id after admission and moves the record to
// running.
func (s *RunStore) SetRunID(jobID, runID string) error {
	if _, err := s.db.Exec(`UPDATE runs SET run_id = ?, status = ?, updated_at = ? WHERE job_id = ?`,
		runID, runRunning, nowUTC(), jobID); err != nil {
		return fmt.Errorf("set run_id: %w", err)
	}
	return nil
}

// SetTerminal stores the final Result envelope and moves the record to a
// terminal status ("done" or "error"). Re-delivery reads this back verbatim.
func (s *RunStore) SetTerminal(jobID, status string, result proto.Result) error {
	b, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE runs SET status = ?, result = ?, updated_at = ? WHERE job_id = ?`,
		status, string(b), nowUTC(), jobID); err != nil {
		return fmt.Errorf("set terminal result: %w", err)
	}
	return nil
}

// GetRun returns a persisted record, or ok=false.
func (s *RunStore) GetRun(jobID string) (RunRecord, bool) {
	var r RunRecord
	var payload, result string
	err := s.db.QueryRow(`SELECT job_id, site_id, payload, run_id, status, attempted_at, result FROM runs WHERE job_id = ?`, jobID).
		Scan(&r.JobID, &r.SiteID, &payload, &r.RunID, &r.Status, &r.AttemptedAt, &result)
	if err != nil {
		return RunRecord{}, false
	}
	r.Payload = []byte(payload)
	r.Result = []byte(result)
	return r, true
}

// ListActive returns every record still in flight, for restart/reconnect
// recovery.
func (s *RunStore) ListActive() ([]RunRecord, error) {
	return s.list(`WHERE status IN ('received','admission_in_flight','running')`)
}

// ListTerminal returns every record with a final result, for idempotent
// re-delivery after a reconnect.
func (s *RunStore) ListTerminal() ([]RunRecord, error) {
	return s.list(`WHERE status IN ('done','error')`)
}

func (s *RunStore) list(where string) ([]RunRecord, error) {
	rows, err := s.db.Query(`SELECT job_id, site_id, payload, run_id, status, attempted_at, result FROM runs ` + where + ` ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunRecord
	for rows.Next() {
		var r RunRecord
		var payload, result string
		if err := rows.Scan(&r.JobID, &r.SiteID, &payload, &r.RunID, &r.Status, &r.AttemptedAt, &result); err != nil {
			return nil, err
		}
		r.Payload = []byte(payload)
		r.Result = []byte(result)
		out = append(out, r)
	}
	return out, rows.Err()
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }
