package settings

import (
	"encoding/json"
	"errors"
	"testing"
)

// rawBody converte um JSON em map[string]json.RawMessage como o handler faz.
func rawBody(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("corpo de teste inválido: %v", err)
	}
	return m
}

func TestParsePatchRejeitaCampoDesconhecido(t *testing.T) {
	_, err := ParsePatch(rawBody(t, `{"id":"hack","merchant_name":"Ok"}`))
	var pe *PatchError
	if !errors.As(err, &pe) {
		t.Fatalf("erro = %v, quer *PatchError", err)
	}
	if pe.Code != CodeUnknownField || pe.Field != "id" {
		t.Errorf("erro = %+v, quer unknown_field em id", pe)
	}
}

func TestParsePatchAceitaCamposConhecidos(t *testing.T) {
	p, err := ParsePatch(rawBody(t, `{"merchant_name":"Bar do Zé","printer_enabled":true}`))
	if err != nil {
		t.Fatalf("patch válido rejeitado: %v", err)
	}
	if len(p.Columns) != 2 {
		t.Fatalf("colunas = %v, quer 2", p.Columns)
	}
	// Ordem canônica: merchant_name vem antes de printer_enabled.
	if p.Columns[0] != "merchant_name" || p.Columns[1] != "printer_enabled" {
		t.Errorf("ordem inesperada: %v", p.Columns)
	}
	if p.Args[0] != "Bar do Zé" || p.Args[1] != true {
		t.Errorf("args inesperados: %v", p.Args)
	}
}

func TestParsePatchEnumPixKeyType(t *testing.T) {
	if _, err := ParsePatch(rawBody(t, `{"pix_key_type":"email"}`)); err != nil {
		t.Fatalf("valor válido rejeitado: %v", err)
	}
	_, err := ParsePatch(rawBody(t, `{"pix_key_type":"bitcoin"}`))
	var pe *PatchError
	if !errors.As(err, &pe) || pe.Code != CodeInvalidValue {
		t.Fatalf("erro = %v, quer invalid_value", err)
	}
}

func TestParsePatchTipos(t *testing.T) {
	casos := []struct {
		nome string
		body string
		code string
	}{
		{"booleano como texto", `{"printer_enabled":"sim"}`, CodeInvalidType},
		{"inteiro como texto", `{"minutes_per_km":"2"}`, CodeInvalidType},
		{"inteiro fracionário", `{"minutes_per_km":2.5}`, CodeInvalidType},
		{"real como texto", `{"delivery_fee":"10"}`, CodeInvalidType},
		{"texto como número", `{"merchant_name":10}`, CodeInvalidType},
		{"texto null", `{"merchant_name":null}`, CodeInvalidType},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			_, err := ParsePatch(rawBody(t, c.body))
			var pe *PatchError
			if !errors.As(err, &pe) || pe.Code != c.code {
				t.Fatalf("erro = %v, quer %s", err, c.code)
			}
		})
	}
}

func TestParsePatchNuláveis(t *testing.T) {
	p, err := ParsePatch(rawBody(t, `{"logo_path":null,"restaurant_lat":-23.5}`))
	if err != nil {
		t.Fatalf("patch válido rejeitado: %v", err)
	}
	if len(p.Columns) != 2 {
		t.Fatalf("colunas = %v", p.Columns)
	}
	if p.Args[0] != (*string)(nil) {
		t.Errorf("logo_path = %v, quer nil", p.Args[0])
	}
	lat, ok := p.Args[1].(*float64)
	if !ok || lat == nil || *lat != -23.5 {
		t.Errorf("restaurant_lat = %v", p.Args[1])
	}
}

func TestParsePatchJSONText(t *testing.T) {
	// String já serializada.
	p, err := ParsePatch(rawBody(t, `{"enabled_payment_methods":"[\"cash\",\"pix\"]"}`))
	if err != nil {
		t.Fatalf("string JSON rejeitada: %v", err)
	}
	if p.Args[0] != `["cash","pix"]` {
		t.Errorf("arg = %v", p.Args[0])
	}

	// Array nativo vira texto.
	p, err = ParsePatch(rawBody(t, `{"delivery_fee_tiers":[{"km":3,"fee":5}]}`))
	if err != nil {
		t.Fatalf("array nativo rejeitado: %v", err)
	}
	if p.Args[0] != `[{"km":3,"fee":5}]` {
		t.Errorf("arg = %v", p.Args[0])
	}
}

func TestParsePatchVazio(t *testing.T) {
	p, err := ParsePatch(nil)
	if err != nil {
		t.Fatalf("patch vazio rejeitado: %v", err)
	}
	if len(p.Columns) != 0 || len(p.Args) != 0 {
		t.Errorf("patch vazio com conteúdo: %+v", p)
	}
}

func TestAssignments(t *testing.T) {
	p := &Patch{Columns: []string{"merchant_name", "printer_enabled"}}
	got := p.Assignments(3)
	if got[0] != `"merchant_name" = $3` || got[1] != `"printer_enabled" = $4` {
		t.Errorf("assignments = %v", got)
	}
}

// Columns e ScanDest têm que andar juntos; se um ganhar coluna e o outro não,
// o Scan quebra em runtime.
func TestScanDestAlinhaComColumns(t *testing.T) {
	var s StoreSettings
	if len(s.ScanDest()) != len(Columns) {
		t.Fatalf("ScanDest tem %d, Columns tem %d", len(s.ScanDest()), len(Columns))
	}
}
