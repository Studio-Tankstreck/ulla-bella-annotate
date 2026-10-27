package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"ullabella-annotate/internal/store"
)

// handlePair redeems a .ullabella Invite and returns the minimum browser
// configuration (deviceId, siteId, origin, displayName, deviceCredential).
// This is the Invite -> Device activation; it is separate from Protocol V1 and
// uses plain REST + JSON error objects, not the V1 envelope.
func (r *relay) handlePair(w http.ResponseWriter, req *http.Request) {
	if !r.pairLimiter.Allow(clientKey(req)) {
		w.Header().Set("Retry-After", "1")
		writePairError(w, http.StatusTooManyRequests, "rate_limited", "too many pairing attempts")
		return
	}

	body, err := io.ReadAll(io.LimitReader(req.Body, maxPairBytes))
	if err != nil {
		writePairError(w, http.StatusBadRequest, store.ErrInvalidRequest, "cannot read request body")
		return
	}
	var in struct {
		Invite string `json:"invite"`
	}
	if err := json.Unmarshal(body, &in); err != nil || strings.TrimSpace(in.Invite) == "" {
		writePairError(w, http.StatusBadRequest, store.ErrInvalidRequest, "invite token required")
		return
	}

	dev, cred, site, err := r.store.RedeemInvite(strings.TrimSpace(in.Invite))
	if err != nil {
		var pe *store.PairError
		if errors.As(err, &pe) {
			writePairError(w, pairStatus(pe.Code), pe.Code, pe.Message)
			return
		}
		log.Printf("relay: redeem invite failed: requestId=%s err=%v", requestID(req), err)
		writePairError(w, http.StatusInternalServerError, "internal_error", "could not redeem invite")
		return
	}

	// Log only safe identities — never the invite token or the credential.
	log.Printf("invite redeemed: requestId=%s deviceId=%s siteId=%s", requestID(req), dev.DeviceID, site.SiteID)
	// The credential is returned exactly once, here; never persisted in plaintext.
	writeJSON(w, http.StatusOK, map[string]any{
		"deviceId":         dev.DeviceID,
		"siteId":           site.SiteID,
		"origin":           site.Origin,
		"displayName":      site.DisplayName,
		"deviceCredential": cred,
	})
}

func pairStatus(code string) int {
	switch code {
	case store.ErrInviteNotFound:
		return http.StatusNotFound
	case store.ErrInviteUsed:
		return http.StatusConflict
	case store.ErrInviteExpired:
		return http.StatusGone
	case store.ErrSiteNotFound:
		return http.StatusNotFound
	case store.ErrSiteDisabled:
		return http.StatusForbidden
	default:
		return http.StatusBadRequest
	}
}

// bearerToken extracts a Bearer credential from the Authorization header, or "".
func bearerToken(req *http.Request) string {
	h := req.Header.Get("Authorization")
	const p = "Bearer "
	if strings.HasPrefix(h, p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writePairError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}
