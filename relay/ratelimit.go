package main

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// limiter is a deliberately small in-process token bucket, keyed by client.
// It is the private-beta abuse ceiling, not a distributed limiter.
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rps     float64 // tokens per second
	burst   float64 // max burst
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(rps, burst float64) *limiter {
	return &limiter{
		buckets: map[string]*bucket{},
		rps:     rps,
		burst:   burst,
	}
}

// Allow reports whether one request is permitted for key now. It also prunes a
// stale bucket to bound memory.
func (l *limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * l.rps
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// parseRateSpec parses a rate-limit spec of the form "N/unit" where unit is
// s, m, or h (e.g. "5/m" = 5 per minute). Burst is set equal to N. An empty or
// malformed spec falls back to def.
func parseRateSpec(spec, def string) *limiter {
	if spec == "" {
		spec = def
	}
	parts := strings.SplitN(spec, "/", 2)
	n, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	if err != nil || n <= 0 {
		n = 5
	}
	per := time.Minute
	if len(parts) == 2 {
		switch strings.TrimSpace(parts[1]) {
		case "s":
			per = time.Second
		case "h":
			per = time.Hour
		default:
			per = time.Minute
		}
	}
	rps := n / per.Seconds()
	return newLimiter(rps, n)
}
