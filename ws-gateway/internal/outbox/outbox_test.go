package outbox

import (
	"encoding/json"
	"testing"
)

type fakeHub struct {
	rooms map[string]int
}

func (f *fakeHub) BroadcastToRoom(room string, payload []byte) int {
	if f.rooms == nil {
		f.rooms = make(map[string]int)
	}
	f.rooms[room]++
	return f.rooms[room]
}

// Envelope tem que ter `emittedAt` no mesmo formato do Node (milissegundos
// sempre, UTC). O cliente compara e ordena por string muitas vezes, e usar
// RFC3339 sem forçar 3 dígitos mascara divergência.
func TestEnvelopeFormato(t *testing.T) {
	b, err := Envelope("order.created", json.RawMessage(`{"orderId":"x"}`))
	if err != nil {
		t.Fatalf("Envelope falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("payload inválido: %v", err)
	}
	if _, ok := m["emittedAt"]; !ok {
		t.Fatal("emittedAt ausente")
	}
	em, ok := m["emittedAt"].(string)
	if !ok {
		t.Fatal("emittedAt não é string")
	}
	// yyyy-mm-ddTHH:MM:SS.000Z — exatamente 3 dígitos de ms
	if len(em) != 24 {
		t.Errorf("tamanho do emittedAt inesperado: %d, quer 24 (yyyy-mm-ddTHH:MM:SS.000Z); valor=%q", len(em), em)
	}
	if em[len(em)-1] != 'Z' || em[4] != '-' || em[10] != 'T' || em[19] != '.' {
		t.Errorf("formato do emittedAt fora do padrão: %q (esperado 2025-10-04T12:00:00.000Z)", em)
	}
	if _, ok := m["type"]; !ok {
		t.Fatal("type ausente")
	}
	if m["type"] != "order.created" {
		t.Errorf("type=%q", m["type"])
	}
}

// Quando o payload for vazio, o envelope tem que conter `payload: null` para o
// cliente não ficar com `undefined`.
func TestEnvelopePayloadNulo(t *testing.T) {
	b, err := Envelope("sync.response", json.RawMessage(``))
	if err != nil {
		t.Fatalf("Envelope falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("payload inválido: %v", err)
	}
	if m["payload"] != nil {
		t.Errorf("payload deve ser null, mas é %T/%v", m["payload"], m["payload"])
	}
}
