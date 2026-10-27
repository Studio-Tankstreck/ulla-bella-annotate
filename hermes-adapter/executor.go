package main

import "ullabella-annotate/internal/proto"

// Outcome is the adapter-internal execution result. It is agent-agnostic: the
// adapter maps it into the V1 Result envelope without leaking any Hermes concept.
type Outcome struct {
	Status            string
	Summary           string
	Verification      *proto.Verification
	ErrorCode         string
	ErrorMessage      string
	AnnotationResults []proto.AnnotationResult
}

// doneOutcome builds a verified-success outcome.
func doneOutcome(summary string) Outcome {
	return Outcome{
		Status:       proto.StatusDone,
		Summary:      summary,
		Verification: &proto.Verification{Status: "passed", Summary: summary},
	}
}

// errorOutcome builds a terminal failure outcome.
func errorOutcome(code, message string) Outcome {
	return Outcome{Status: proto.StatusError, ErrorCode: code, ErrorMessage: message}
}

// normalizeAnnotationResults guarantees exactly one result per submitted
// annotation, in job order. It is a no-op (returns nil) when the executor
// produced no per-annotation results, preserving the single-annotation
// back-compat path (job-level summary/verification only). When results are
// present it:
//   - keeps the first result for each submitted annotationId (duplicates dropped);
//   - fills any submitted annotationId with no result as status "error" with
//     code "no_result";
//   - drops results whose annotationId was not part of the submitted Job.
func normalizeAnnotationResults(annotations []proto.Annotation, results []proto.AnnotationResult) []proto.AnnotationResult {
	if len(results) == 0 {
		return nil
	}
	order := make([]string, 0, len(annotations))
	seen := make(map[string]bool, len(annotations))
	for _, a := range annotations {
		if !seen[a.AnnotationID] {
			seen[a.AnnotationID] = true
			order = append(order, a.AnnotationID)
		}
	}
	byID := make(map[string]proto.AnnotationResult, len(results))
	for _, r := range results {
		if seen[r.AnnotationID] {
			if _, ok := byID[r.AnnotationID]; !ok {
				byID[r.AnnotationID] = r // first wins
			}
		}
	}
	out := make([]proto.AnnotationResult, 0, len(order))
	for _, id := range order {
		if r, ok := byID[id]; ok {
			out = append(out, r)
		} else {
			out = append(out, proto.AnnotationResult{
				AnnotationID: id,
				Status:       proto.StatusError,
				Error:        &proto.Error{Code: "no_result", Message: "no result was produced for this annotation"},
			})
		}
	}
	return out
}

// ResolvedTarget is one annotation bound to a concrete workspace file.
type ResolvedTarget struct {
	Annotation proto.Annotation
	FilePath   string
}

// SiteContext is the validated site + resolved targets handed to an Executor.
type SiteContext struct {
	Config  SiteConfig
	Job     proto.Job
	Targets []ResolvedTarget
}

// Executor turns a validated Job into an Outcome. StubExecutor (Task 06) and
// HermesExecutor (Task 07) are the two implementations.
type Executor interface {
	Execute(ctx SiteContext) Outcome
}

// StubExecutor returns a hardcoded done result — proves transport, not editing.
type StubExecutor struct{}

func (StubExecutor) Execute(SiteContext) Outcome {
	return doneOutcome("H1 now reads 'Our Services'")
}
