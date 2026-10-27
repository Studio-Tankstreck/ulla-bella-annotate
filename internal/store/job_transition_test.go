package store

import "testing"

func TestSetJobResultLateWorkingDoesNotOverwriteDone(t *testing.T) {
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "accepted", `{"accepted"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetJobResult("job1", "done", `{"done"}`); err != nil {
		t.Fatal(err)
	}
	applied, err := s.SetJobResult("job1", "working", `{"working"}`)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("a late working result must not overwrite a terminal done")
	}
	job, _ := s.GetJob("job1")
	if job.Status != "done" || job.Result != `{"done"}` {
		t.Fatalf("job = %+v, want terminal done preserved", job)
	}
}

func TestSetJobResultLateWorkingDoesNotOverwriteError(t *testing.T) {
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "accepted", `{"accepted"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetJobResult("job1", "error", `{"error"}`); err != nil {
		t.Fatal(err)
	}
	applied, _ := s.SetJobResult("job1", "working", `{"working"}`)
	if applied {
		t.Fatal("a late working result must not overwrite a terminal error")
	}
	job, _ := s.GetJob("job1")
	if job.Status != "error" || job.Result != `{"error"}` {
		t.Fatalf("job = %+v, want terminal error preserved", job)
	}
}

func TestSetJobResultLateAcceptedDoesNotOverwriteDone(t *testing.T) {
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "accepted", `{"accepted"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetJobResult("job1", "done", `{"done"}`); err != nil {
		t.Fatal(err)
	}
	applied, _ := s.SetJobResult("job1", "accepted", `{"accepted"}`)
	if applied {
		t.Fatal("a late accepted result must not overwrite a terminal done")
	}
}

func TestSetJobResultTerminalRedeliveryIdempotent(t *testing.T) {
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "accepted", `{"accepted"}`); err != nil {
		t.Fatal(err)
	}
	if applied, _ := s.SetJobResult("job1", "done", `{"done"}`); !applied {
		t.Fatal("working -> done must apply")
	}
	if applied, _ := s.SetJobResult("job1", "done", `{"done"}`); !applied {
		t.Fatal("terminal redelivery must apply")
	}
}

func TestSetJobResultWorkingToDoneApplies(t *testing.T) {
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "working", `{"working"}`); err != nil {
		t.Fatal(err)
	}
	if applied, _ := s.SetJobResult("job1", "done", `{"done"}`); !applied {
		t.Fatal("working -> done must apply")
	}
	job, _ := s.GetJob("job1")
	if job.Status != "done" {
		t.Fatalf("status = %q, want done", job.Status)
	}
}

func TestSetJobResultPreservesTerminalResult(t *testing.T) {
	// A late working update must not erase the terminal result's payload (which
	// carries verification + annotationResults).
	s := openTest(t)
	if err := s.CreateJob("job1", "dev1", "h", "accepted", `{"accepted"}`); err != nil {
		t.Fatal(err)
	}
	donePayload := `{"status":"done","annotationResults":[{"annotationId":"a1","status":"done"}]}`
	if _, err := s.SetJobResult("job1", "done", donePayload); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetJobResult("job1", "working", `{"status":"working","activity":{"kind":"using_tools"}}`); err != nil {
		t.Fatal(err)
	}
	job, _ := s.GetJob("job1")
	if job.Result != donePayload {
		t.Fatalf("terminal result was clobbered: %q", job.Result)
	}
}
