package main

import (
	"testing"

	"ullabella-annotate/internal/proto"
)

func ann(id string) proto.Annotation {
	return proto.Annotation{AnnotationID: id}
}

func ar(id, status string) proto.AnnotationResult {
	return proto.AnnotationResult{AnnotationID: id, Status: status}
}

func TestNormalizeAnnotationResultsNoResults(t *testing.T) {
	// No per-annotation results -> nil (single-annotation back-compat path).
	if got := normalizeAnnotationResults([]proto.Annotation{ann("a")}, nil); got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}

func TestNormalizeAnnotationResultsFillsMissingAndOrder(t *testing.T) {
	job := []proto.Annotation{ann("a"), ann("b"), ann("c")}
	results := []proto.AnnotationResult{ar("c", "done"), ar("a", "error")}
	got := normalizeAnnotationResults(job, results)
	if len(got) != 3 {
		t.Fatalf("expected 3 results, got %d", len(got))
	}
	if got[0].AnnotationID != "a" || got[0].Status != proto.StatusError {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].AnnotationID != "b" || got[1].Status != proto.StatusError ||
		got[1].Error == nil || got[1].Error.Code != "no_result" {
		t.Errorf("got[1] = %+v (want no_result error for missing b)", got[1])
	}
	if got[2].AnnotationID != "c" || got[2].Status != proto.StatusDone {
		t.Errorf("got[2] = %+v", got[2])
	}
}

func TestNormalizeAnnotationResultsDropsUnknownAndDuplicates(t *testing.T) {
	job := []proto.Annotation{ann("a"), ann("b")}
	results := []proto.AnnotationResult{
		ar("a", "error"),
		ar("a", "done"), // duplicate: first wins
		ar("b", "done"),
		ar("zzz", "done"), // unknown: dropped
	}
	got := normalizeAnnotationResults(job, results)
	if len(got) != 2 {
		t.Fatalf("expected 2 results, got %d", len(got))
	}
	if got[0].AnnotationID != "a" || got[0].Status != proto.StatusError {
		t.Errorf("got[0] = %+v (want first-wins error)", got[0])
	}
	if got[1].AnnotationID != "b" || got[1].Status != proto.StatusDone {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func TestOutcomeToResultMapsAnnotationResults(t *testing.T) {
	o := Outcome{
		Status: proto.StatusDone,
		AnnotationResults: []proto.AnnotationResult{
			{AnnotationID: "a", Status: proto.StatusDone},
			{AnnotationID: "b", Status: proto.StatusError, Error: &proto.Error{Code: "edit_failed", Message: "x"}},
		},
	}
	res := outcomeToResult("job_1", o)
	if res.JobID != "job_1" || res.Status != proto.StatusDone {
		t.Fatalf("res = %+v", res)
	}
	if len(res.AnnotationResults) != 2 {
		t.Fatalf("expected 2 annotationResults, got %d", len(res.AnnotationResults))
	}
	if res.AnnotationResults[0].AnnotationID != "a" {
		t.Errorf("res.AnnotationResults[0] = %+v", res.AnnotationResults[0])
	}
	if res.AnnotationResults[1].Error == nil || res.AnnotationResults[1].Error.Code != "edit_failed" {
		t.Errorf("res.AnnotationResults[1] = %+v", res.AnnotationResults[1])
	}
}

func TestOutcomeToResultSingleAnnotationBackCompat(t *testing.T) {
	// No per-annotation results -> Result.AnnotationResults omitted (nil).
	res := outcomeToResult("job_1", doneOutcome("ok"))
	if res.AnnotationResults != nil {
		t.Fatalf("expected nil annotationResults, got %v", res.AnnotationResults)
	}
	if res.Status != proto.StatusDone || res.Verification == nil {
		t.Fatalf("res = %+v", res)
	}
}
