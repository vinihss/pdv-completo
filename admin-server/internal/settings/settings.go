// Package settings modela a tabela `store_settings` de um tenant.
//
// A tabela é de COLUNAS FIXAS (não JSONB), então o UPDATE parcial só pode
// tocar colunas conhecidas. É por isso que existe a whitelist: o mapa que vem
// no corpo do PUT nunca vira identificador SQL. Chave fora da lista é 400, e
// nunca interpolada.
package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Columns é a ordem canônica das colunas lidas/escritas. O SELECT, o RETURNING
// e o ScanDest usam esta ordem — não reordene sem conferir os três.
var Columns = []string{
	"id",
	"merchant_name",
	"merchant_city",
	"logo_path",
	"brand_color",
	"pix_key",
	"pix_key_type",
	"uses_tables",
	"kitchen_enabled",
	"uses_delivery",
	"ifood_integration_enabled",
	"inventory_enabled",
	"purchase_enabled",
	"enabled_payment_methods",
	"kitchen_prep_warn_min",
	"kitchen_prep_urgent_min",
	"kitchen_pickup_urgent_min",
	"delivery_fee",
	"restaurant_lat",
	"restaurant_long",
	"free_delivery_min",
	"delivery_fee_tiers",
	"printer_enabled",
	"printer_auto_print",
	"delivery_prep_minutes",
	"minutes_per_km",
}

// StoreSettings é a linha tipada. Campos anuláveis saem como ponteiro, para o
// JSON distinguir `null` de zero.
type StoreSettings struct {
	ID                     string   `json:"id"`
	MerchantName           string   `json:"merchant_name"`
	MerchantCity           string   `json:"merchant_city"`
	LogoPath               *string  `json:"logo_path"`
	BrandColor             string   `json:"brand_color"`
	PixKey                 string   `json:"pix_key"`
	PixKeyType             string   `json:"pix_key_type"`
	UsesTables             bool     `json:"uses_tables"`
	KitchenEnabled         bool     `json:"kitchen_enabled"`
	UsesDelivery           bool     `json:"uses_delivery"`
	IfoodIntegration       bool     `json:"ifood_integration_enabled"`
	InventoryEnabled       bool     `json:"inventory_enabled"`
	PurchaseEnabled        bool     `json:"purchase_enabled"`
	EnabledPaymentMethods  string   `json:"enabled_payment_methods"`
	KitchenPrepWarnMin     int      `json:"kitchen_prep_warn_min"`
	KitchenPrepUrgentMin   int      `json:"kitchen_prep_urgent_min"`
	KitchenPickupUrgentMin int      `json:"kitchen_pickup_urgent_min"`
	DeliveryFee            float64  `json:"delivery_fee"`
	RestaurantLat          *float64 `json:"restaurant_lat"`
	RestaurantLong         *float64 `json:"restaurant_long"`
	FreeDeliveryMin        float64  `json:"free_delivery_min"`
	DeliveryFeeTiers       string   `json:"delivery_fee_tiers"`
	PrinterEnabled         bool     `json:"printer_enabled"`
	PrinterAutoPrint       bool     `json:"printer_auto_print"`
	DeliveryPrepMinutes    int      `json:"delivery_prep_minutes"`
	MinutesPerKM           int      `json:"minutes_per_km"`
}

// ScanDest devolve os alvos de Scan na MESMA ordem de Columns. Há um teste que
// compara os tamanhos — se divergirem, o Scan quebra com "expected N destination
// arguments", que é fácil de diagnosticar, mas melhor pegar antes.
func (s *StoreSettings) ScanDest() []any {
	return []any{
		&s.ID,
		&s.MerchantName,
		&s.MerchantCity,
		&s.LogoPath,
		&s.BrandColor,
		&s.PixKey,
		&s.PixKeyType,
		&s.UsesTables,
		&s.KitchenEnabled,
		&s.UsesDelivery,
		&s.IfoodIntegration,
		&s.InventoryEnabled,
		&s.PurchaseEnabled,
		&s.EnabledPaymentMethods,
		&s.KitchenPrepWarnMin,
		&s.KitchenPrepUrgentMin,
		&s.KitchenPickupUrgentMin,
		&s.DeliveryFee,
		&s.RestaurantLat,
		&s.RestaurantLong,
		&s.FreeDeliveryMin,
		&s.DeliveryFeeTiers,
		&s.PrinterEnabled,
		&s.PrinterAutoPrint,
		&s.DeliveryPrepMinutes,
		&s.MinutesPerKM,
	}
}

// Códigos de erro de validação do patch. O handler os mapeia direto para o
// corpo `{"error":{"code":...}}`.
const (
	CodeUnknownField = "unknown_field"
	CodeInvalidType  = "invalid_type"
	CodeInvalidValue = "invalid_value"
)

// PatchError é um erro de validação do corpo do PUT.
type PatchError struct {
	Code    string
	Field   string
	Message string
}

func (e *PatchError) Error() string {
	return fmt.Sprintf("%s: campo %q — %s", e.Code, e.Field, e.Message)
}

// fieldKind classifica cada coluna para a validação e conversão do patch.
type fieldKind int

const (
	kindText fieldKind = iota
	kindNullableText
	kindBool
	kindInt
	kindReal
	kindNullableReal
	kindPixKeyType
	kindJSONText
)

// whitelist é a fonte de verdade do que pode ser alterado. `id` fica de fora
// de propósito: é a chave da linha singleton.
var whitelist = map[string]fieldKind{
	"merchant_name":             kindText,
	"merchant_city":             kindText,
	"logo_path":                 kindNullableText,
	"brand_color":               kindText,
	"pix_key":                   kindText,
	"pix_key_type":              kindPixKeyType,
	"uses_tables":               kindBool,
	"kitchen_enabled":           kindBool,
	"uses_delivery":             kindBool,
	"ifood_integration_enabled": kindBool,
	"inventory_enabled":         kindBool,
	"purchase_enabled":          kindBool,
	"enabled_payment_methods":   kindJSONText,
	"kitchen_prep_warn_min":     kindInt,
	"kitchen_prep_urgent_min":   kindInt,
	"kitchen_pickup_urgent_min": kindInt,
	"delivery_fee":              kindReal,
	"restaurant_lat":            kindNullableReal,
	"restaurant_long":           kindNullableReal,
	"free_delivery_min":         kindReal,
	"delivery_fee_tiers":        kindJSONText,
	"printer_enabled":           kindBool,
	"printer_auto_print":        kindBool,
	"delivery_prep_minutes":     kindInt,
	"minutes_per_km":            kindInt,
}

// allowedPixKeyTypes espelha o enum do Postgres.
var allowedPixKeyTypes = map[string]bool{
	"cpf": true, "cnpj": true, "email": true, "phone": true, "random": true,
}

// Patch é um UPDATE parcial validado: colunas na ordem de Columns e os
// respectivos argumentos.
type Patch struct {
	Columns []string
	Args    []any
}

// ParsePatch valida e converte o corpo do PUT. Devolve *PatchError para o
// handler traduzir em 400.
func ParsePatch(raw map[string]json.RawMessage) (*Patch, error) {
	p := &Patch{}
	if len(raw) == 0 {
		return p, nil
	}

	for key := range raw {
		if _, ok := whitelist[key]; !ok {
			return nil, &PatchError{
				Code:    CodeUnknownField,
				Field:   key,
				Message: "campo não editável",
			}
		}
	}

	// Percorre Columns para a saída ser determinística (mapa do Go não tem
	// ordem), o que deixa o UPDATE e os testes previsíveis.
	for _, col := range Columns {
		value, ok := raw[col]
		if !ok {
			continue
		}
		converted, err := parseField(col, whitelist[col], value)
		if err != nil {
			return nil, err
		}
		p.Columns = append(p.Columns, col)
		p.Args = append(p.Args, converted)
	}
	return p, nil
}

// Assignments devolve os fragmentos `"col" = $N`. start é o número do primeiro
// placeholder. O identificador é entre aspas mesmo vindo da whitelist:
// interpolação de string em SQL só é aceitável quando o valor é constante.
func (p *Patch) Assignments(start int) []string {
	out := make([]string, len(p.Columns))
	for i, col := range p.Columns {
		out[i] = fmt.Sprintf("%s = $%d", quoteIdent(col), start+i)
	}
	return out
}

func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func parseField(name string, kind fieldKind, raw json.RawMessage) (any, error) {
	switch kind {
	case kindText:
		if isNull(raw) {
			return nil, typeErr(name, "texto")
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, typeErr(name, "texto")
		}
		return s, nil

	case kindNullableText:
		if isNull(raw) {
			return (*string)(nil), nil
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, typeErr(name, "texto ou null")
		}
		return &s, nil

	case kindBool:
		if isNull(raw) {
			return nil, typeErr(name, "booleano")
		}
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, typeErr(name, "booleano")
		}
		return b, nil

	case kindInt:
		if isNull(raw) {
			return nil, typeErr(name, "inteiro")
		}
		var n int
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, typeErr(name, "inteiro")
		}
		return n, nil

	case kindReal:
		if isNull(raw) {
			return nil, typeErr(name, "número")
		}
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, typeErr(name, "número")
		}
		return f, nil

	case kindNullableReal:
		if isNull(raw) {
			return (*float64)(nil), nil
		}
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, typeErr(name, "número ou null")
		}
		return &f, nil

	case kindPixKeyType:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, typeErr(name, "texto")
		}
		if !allowedPixKeyTypes[s] {
			return nil, &PatchError{
				Code:    CodeInvalidValue,
				Field:   name,
				Message: "valor inválido para pix_key_type",
			}
		}
		return s, nil

	case kindJSONText:
		return coerceJSONText(name, raw)
	}
	return nil, typeErr(name, "tipo desconhecido")
}

// coerceJSONText aceita a string já serializada (ex.: "[\"cash\"]") ou o valor
// nativo (array/objeto), que é serializado aqui. A coluna é text.
func coerceJSONText(name string, raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || isNull(raw) {
		return "", typeErr(name, "JSON em texto")
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return "", typeErr(name, "JSON em texto")
		}
		return s, nil
	}
	var v any
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return "", &PatchError{
			Code:    CodeInvalidValue,
			Field:   name,
			Message: "JSON inválido",
		}
	}
	return string(trimmed), nil
}

func isNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

func typeErr(name, want string) *PatchError {
	return &PatchError{
		Code:    CodeInvalidType,
		Field:   name,
		Message: "tipo inválido, esperado " + want,
	}
}
