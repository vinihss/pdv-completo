package licensego

import (
	"testing"
	"time"

	"github.com/example/license-platform/sdk/licensego/model"
)

func TestComputeState_ExpiredAlwaysWins(t *testing.T) {
	now := time.Now()
	doc := model.Document{
		ExpiresAt:  now.Add(-time.Hour),
		LeaseUntil: now.Add(time.Hour), // lease ainda válido, mas licença expirou
	}
	if got := computeState(doc, now, true); got != model.StateExpired {
		t.Fatalf("esperava StateExpired mesmo com servidor alcançado, obteve %v", got)
	}
}

func TestComputeState_ServerReached_IsActive(t *testing.T) {
	now := time.Now()
	doc := model.Document{ExpiresAt: now.Add(24 * time.Hour)}
	if got := computeState(doc, now, true); got != model.StateActive {
		t.Fatalf("esperava StateActive, obteve %v", got)
	}
}

func TestComputeState_ServerUnreachable_WithinLease_IsOffline(t *testing.T) {
	now := time.Now()
	doc := model.Document{
		ExpiresAt:  now.Add(24 * time.Hour),
		LeaseUntil: now.Add(time.Hour),
	}
	if got := computeState(doc, now, false); got != model.StateOffline {
		t.Fatalf("esperava StateOffline, obteve %v", got)
	}
}

func TestComputeState_ServerUnreachable_LeaseExpiredButWithinOfflineWindow_IsGracePeriod(t *testing.T) {
	now := time.Now()
	doc := model.Document{
		ExpiresAt:    now.Add(24 * time.Hour),
		LeaseUntil:   now.Add(-time.Hour), // lease já expirou
		OfflineUntil: now.Add(48 * time.Hour),
	}
	if got := computeState(doc, now, false); got != model.StateGracePeriod {
		t.Fatalf("esperava StateGracePeriod, obteve %v", got)
	}
}

func TestComputeState_ServerUnreachable_PastOfflineWindow_IsInvalid(t *testing.T) {
	now := time.Now()
	doc := model.Document{
		ExpiresAt:    now.Add(24 * time.Hour),
		LeaseUntil:   now.Add(-48 * time.Hour),
		OfflineUntil: now.Add(-time.Hour), // janela de tolerância já passou
	}
	if got := computeState(doc, now, false); got != model.StateInvalid {
		t.Fatalf("esperava StateInvalid, obteve %v", got)
	}
}

func TestComputeState_NoLeaseSet_TreatedAsWithinLease(t *testing.T) {
	now := time.Now()
	doc := model.Document{ExpiresAt: now.Add(24 * time.Hour)} // LeaseUntil zero
	if got := computeState(doc, now, false); got != model.StateOffline {
		t.Fatalf("esperava StateOffline quando lease_until não foi definido, obteve %v", got)
	}
}
