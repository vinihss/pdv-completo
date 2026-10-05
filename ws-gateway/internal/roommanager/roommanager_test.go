package roommanager

import (
	"reflect"
	"testing"
)

// A autorização de room é o controle de acesso do realtime inteiro: quem assina
// qual room decide o que o garçom vê, se o caixa ouve a comanda alheia, e se o
// entregador recebe o `delivery.assigned` que cria a fila dele.
//
// Estes casos são cópia de `canJoinRoom` (realtime.routes.ts). Se alguém mexer
// na matriz aqui e no backend sem os dois lados, a falha aparece como
// "evento não chega" ou "vaza dado" — os dois ruins, e o segundo um bug de
// segurança. Por isso os casos negativos importam tanto quanto os positivos.
func TestCanJoin(t *testing.T) {
	const (
		u1 = "11111111-1111-1111-1111-111111111111"
		u2 = "22222222-2222-2222-2222-222222222222"
	)

	tests := []struct {
		name string
		role string
		sub  string
		room string
		want bool
	}{
		// --- room pessoal ---
		{"garçom no próprio room", "waiter", u1, "waiter:" + u1, true},
		{"garçom no room de outro", "waiter", u1, "waiter:" + u2, false},
		{"gerente no próprio room pessoal", "manager", u1, "waiter:" + u1, true},

		// --- central de alertas: público, do papel, do usuário ---
		{"alertas públicos", "waiter", u1, "alerts", true},
		{"alertas do próprio papel", "waiter", u1, "alerts:waiter", true},
		{"GERENTE NÃO pode assinar alertas de gerente sendo garçom", "waiter", u1, "alerts:manager", false},
		{"alertas do próprio usuário", "waiter", u1, "alerts:user:" + u1, true},
		{"alertas do usuário alheio", "waiter", u1, "alerts:user:" + u2, false},
		{"caixa não escuta alertas de gerente", "cashier", u1, "alerts:manager", false},

		// --- waiter ---
		{"garçom vê cozinha", "waiter", u1, "kitchen-display", true},
		{"garçom vê entregas", "waiter", u1, "deliveries", true},
		{"garçom NÃO vê gaveta de caixa", "waiter", u1, "cash-drawer", false},
		{"garçom NÃO vê estoque", "waiter", u1, "inventory", false},
		{"garçom NÃO vê whatsapp", "waiter", u1, "whatsapp", false},

		// --- kitchen ---
		{"cozinha vê cozinha", "kitchen", u1, "kitchen-display", true},
		{"cozinha NÃO vê gaveta", "kitchen", u1, "cash-drawer", false},
		{"cozinha NÃO vê entregas", "kitchen", u1, "deliveries", false},
		{"cozinha NÃO vê estoque", "kitchen", u1, "inventory", false},

		// --- cashier ---
		{"caixa vê gaveta", "cashier", u1, "cash-drawer", true},
		{"caixa NÃO vê estoque", "cashier", u1, "inventory", false},
		{"caixa NÃO vê entregas", "cashier", u1, "deliveries", false},
		{"caixa NÃO vê cozinha", "cashier", u1, "kitchen-display", false},

		// --- courier ---
		{"entregador vê entregas", "courier", u1, "deliveries", true},
		{"entregador NÃO vê gaveta", "courier", u1, "cash-drawer", false},
		{"entregador NÃO vê cozinha", "courier", u1, "kitchen-display", false},
		{"entregador NÃO vê estoque", "courier", u1, "inventory", false},

		// --- manager: tudo ---
		{"gerente vê cozinha", "manager", u1, "kitchen-display", true},
		{"gerente vê entregas", "manager", u1, "deliveries", true},
		{"gerente vê gaveta", "manager", u1, "cash-drawer", true},
		{"gerente vê estoque", "manager", u1, "inventory", true},
		{"gerente vê whatsapp", "manager", u1, "whatsapp", true},

		// --- papel desconhecido / token forjado ---
		{"papel desconhecido não acessa gaveta", "hacker", u1, "cash-drawer", false},
		{"papel desconhecido não acessa estoque", "hacker", u1, "inventory", false},
		{"papel vazio não acessa gaveta", "", u1, "cash-drawer", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanJoin(tt.role, tt.sub, tt.room); got != tt.want {
				t.Errorf("CanJoin(role=%q, sub=%q, room=%q) = %v, quer %v",
					tt.role, tt.sub, tt.room, got, tt.want)
			}
		})
	}
}

// Os rooms do handshake não são um detalhe de conveniência: `deliveries` e o sino
// estão aqui de propósito, porque o dispatcher marca o evento como publicado
// mesmo sem assinante. Se saírem daqui e passarem a depender do `join` do client
// (que chega um RTT depois), o `delivery.assigned` que cai nessa janela se perde
// de vez — é o evento que cria a fila do entregador.
func TestInitialRooms(t *testing.T) {
	const u1 = "11111111-1111-1111-1111-111111111111"

	tests := []struct {
		role string
		want []string
	}{
		{"waiter", []string{
			"waiter:" + u1, "alerts", "alerts:waiter", "alerts:user:" + u1,
		}},
		{"kitchen", []string{
			"waiter:" + u1, "kitchen-display", "alerts", "alerts:kitchen", "alerts:user:" + u1,
		}},
		{"cashier", []string{
			"waiter:" + u1, "cash-drawer", "alerts", "alerts:cashier", "alerts:user:" + u1,
		}},
		{"courier", []string{
			"waiter:" + u1, "deliveries", "alerts", "alerts:courier", "alerts:user:" + u1,
		}},
		{"manager", []string{
			"waiter:" + u1, "cash-drawer", "inventory", "deliveries",
			"alerts", "alerts:manager", "alerts:user:" + u1,
		}},
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			got := InitialRooms(tt.role, u1)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("InitialRooms(%q) =\n  %v\nquer\n  %v", tt.role, got, tt.want)
			}
		})
	}
}

// Todo room inicial tem que passar por CanJoin. Se algum dia InitialRooms e
// CanJoin divergirem, o gateway entra num room que ele mesmo negaria no `join` —
// bug que só aparece quando o client tenta assinar o mesmo room de novo.
func TestInitialRoomsAreAllJoinable(t *testing.T) {
	const u1 = "11111111-1111-1111-1111-111111111111"
	for _, role := range []string{"waiter", "kitchen", "cashier", "courier", "manager", "desconhecido"} {
		for _, room := range InitialRooms(role, u1) {
			if !CanJoin(role, u1, room) {
				t.Errorf("papel %q entrou no room %q no handshake, mas CanJoin nega", role, room)
			}
		}
	}
}

// O WS público é alcançável sem token. O regex é a única barreira entre o
// cliente anônimo e os rooms internos — se ele deixar de casar `order:<uuid>`,
// qualquer um pode assinar `cash-drawer` e ouvir a comanda.
func TestIsOrderRoom(t *testing.T) {
	tests := []struct {
		room string
		want bool
	}{
		{"order:3f2504e0-4f89-11d3-9a0c-0305e82c3301", true},
		{"order:3F2504E0-4F89-11D3-9A0C-0305E82C3301", true}, // case-insensitive, igual ao Node
		{"order:3f2504e0-4f89-11d3-9a0c-0305e82c330", false}, // segmento curto
		{"order:not-a-uuid", false},
		{"order:", false},
		{"cash-drawer", false},
		{"deliveries", false},
		{"alerts:manager", false},
		{"order:3f2504e0-4f89-11d3-9a0c-0305e82c3301-extra", false},
		{"prefixo-order:3f2504e0-4f89-11d3-9a0c-0305e82c3301", false},
	}

	for _, tt := range tests {
		t.Run(tt.room, func(t *testing.T) {
			if got := IsOrderRoom(tt.room); got != tt.want {
				t.Errorf("IsOrderRoom(%q) = %v, quer %v", tt.room, got, tt.want)
			}
		})
	}
}
