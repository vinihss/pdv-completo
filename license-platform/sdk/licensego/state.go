package licensego

import (
	"time"

	"github.com/example/license-platform/sdk/licensego/model"
)

// computeState decide o estado operacional a partir de um documento já
// verificado, do instante atual e de se o servidor foi alcançável
// nesta tentativa. É função pura — sem I/O — para poder ser testada
// exaustivamente sem rede nem cache real.
//
// Regras, na ordem em que são checadas:
//  1. Se a licença já passou de expires_at, o estado é sempre "expired",
//     independentemente de o servidor estar acessível.
//  2. Se o servidor foi consultado com sucesso nesta chamada, o estado
//     é "active" — o documento acabou de ser revalidado.
//  3. Sem contato com o servidor (falha de rede, ou decisão de usar
//     cache por já estar dentro do lease):
//     a) dentro do lease (now <= lease_until): "active" se a leitura
//        veio de um cache ainda fresco, "offline" se veio de uma
//        tentativa de rede que falhou mas o cache ainda está dentro
//        do lease.
//     b) fora do lease mas dentro da janela de tolerância offline
//        (now <= offline_until): "grace_period".
//     c) fora da janela de tolerância: "invalid" — o cache não pode
//        mais ser confiado sem contato com o servidor.
func computeState(doc model.Document, now time.Time, serverReached bool) model.State {
	if !doc.ExpiresAt.IsZero() && now.After(doc.ExpiresAt) {
		return model.StateExpired
	}

	if serverReached {
		return model.StateActive
	}

	// Sem contato com o servidor nesta chamada: decide com base no
	// cache local.
	withinLease := doc.LeaseUntil.IsZero() || !now.After(doc.LeaseUntil)
	if withinLease {
		return model.StateOffline
	}

	withinOfflineWindow := !doc.OfflineUntil.IsZero() && !now.After(doc.OfflineUntil)
	if withinOfflineWindow {
		return model.StateGracePeriod
	}

	return model.StateInvalid
}
