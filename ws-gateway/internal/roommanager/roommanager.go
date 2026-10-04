// Package roommanager é a POLÍTICA de rooms: quem pode assinar o quê, e com
// quais rooms cada perfil já entra no handshake. Não guarda estado de conexão.
//
// A separação é deliberada. A versão anterior deste arquivo mantinha dois
// índices de sala (room→conns e conn→rooms) ao lado do connmanager, que também
// guardava `conn.Rooms` — três lugares dizendo a mesma coisa, que divergiam
// silenciosamente. Aqui responde só "isso é permitido?"; quem é quem está
// conectado é do connmanager.
//
// Toda a lógica é cópia de backend/src/http/routes/realtime.routes.ts
// (`canJoinRoom` + os `initialRooms`). Mudar um dos dois lados sem o outro
// muda o que o garçom consegue ouvir — os testes deste pacote existem para
// travar essa paridade.
package roommanager

import "regexp"

// AlertsRoom é a central de alertas: o room público, onde entra o alerta sem
// restrição de público (ver ALERTS_ROOM em alert.usecases.ts).
const AlertsRoom = "alerts"

// AlertsUserRoomFor é o room privado de um usuário — o par de `alertUserToken`
// no realtime (`alerts:user:<id>`). É ele que entrega o alerta direcionado
// (audiência individual, ex.: "essa entrega agora é sua") sem o client precisar
// inventar um room novo.
func AlertsUserRoomFor(userID string) string {
	return AlertsRoom + ":user:" + userID
}

// AlertsRoleRoomFor é o room de alertas de um papel (`alerts:manager`).
func AlertsRoleRoomFor(role string) string {
	return AlertsRoom + ":" + role
}

// WaiterRoomFor é o room pessoal do garçom (`waiter:<id>`).
func WaiterRoomFor(userID string) string {
	return "waiter:" + userID
}

// orderRoomRE limita o WS público a `order:<uuid>`. Sem isso um cliente anônimo
// (que não tem JWT) poderia assinar `cash-drawer` e ouvir a comanda. O UUID é a
// "senha" de fato — mesmo modelo de confiança do GET /public/orders/:id/status.
var orderRoomRE = regexp.MustCompile(`(?i)^order:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// IsOrderRoom reporta se o room é um `order:<uuid>` — o único alcançável pelo
// WS anônimo.
func IsOrderRoom(room string) bool {
	return orderRoomRE.MatchString(room)
}

// InitialRooms devolve os rooms que a conexão já entra no handshake, sem passar
// pelo `join`. Cópia linha a linha de realtime.routes.ts, incluindo a ordem
// (irrelevante para o resultado, mas mantida para comparar os dois lados).
//
// O motivo de `deliveries` e do sino estarem aqui e não só no `join` do client
// está no comentário original: entre o login e o `join` (ida e volta do WS,
// ~1 RTT) o evento era perdido de vez — e o evento que cai exatamente nessa
// janela é o `delivery.assigned`, que é justamente o que o entregador precisa
// (a atribuição é o que cria a fila dele). O dispatcher marca a publicação como
// feita mesmo sem assinante, então não há redelivery: sem isto, o som e a
// atualização da tela dependeriam de o `join` ganhar a corrida.
func InitialRooms(role, sub string) []string {
	rooms := []string{WaiterRoomFor(sub)}

	if role == "kitchen" {
		rooms = append(rooms, "kitchen-display")
	}
	// Caixa e gerente acompanham o fluxo de caixa ao vivo (pagamentos em dinheiro
	// também são broadcast para esse room).
	if role == "cashier" || role == "manager" {
		rooms = append(rooms, "cash-drawer")
	}
	if role == "manager" {
		rooms = append(rooms, "inventory")
	}
	if role == "manager" || role == "courier" {
		rooms = append(rooms, "deliveries")
	}

	return append(rooms, AlertsRoom, AlertsRoleRoomFor(role), AlertsUserRoomFor(sub))
}

// CanJoin decide se um usuário autenticado pode assinar `room` via mensagem
// `join`. Cópia de `canJoinRoom` do backend.
func CanJoin(role, sub, room string) bool {
	if room == WaiterRoomFor(sub) {
		return true
	}
	// Central de alertas: o público, o do PRÓPRIO papel e o do PRÓPRIO usuário.
	// Autorizar o próprio e não "o room de qualquer papel" é o que impede o
	// garçom de assinar `alerts:manager` e ouvir a comanda que ele não deveria
	// — é o mesmo recorte que o `audience_roles` faz no REST.
	if room == AlertsRoom || room == AlertsRoleRoomFor(role) {
		return true
	}
	if room == AlertsUserRoomFor(sub) {
		return true
	}

	switch role {
	case "waiter":
		// O garçom ainda pode assinar `deliveries` — é um vazamento de endereço de
		// cliente que ele JÁ CONHECE (ele abriu a comanda), então não é
		// prioritário. Fica assim de propósito.
		return room == "kitchen-display" || room == "deliveries"
	case "manager":
		// `whatsapp` = status de entrega/leitura das mensagens enviadas, publicado
		// pelo webhook `messages.statuses`.
		return room == "kitchen-display" ||
			room == "deliveries" ||
			room == "cash-drawer" ||
			room == "inventory" ||
			room == "whatsapp"
	case "kitchen":
		return room == "kitchen-display"
	case "cashier":
		return room == "cash-drawer"
	case "courier":
		return room == "deliveries"
	default:
		// Papel desconhecido (token válido mas com `role` que o backend não emite):
		// nega. Allow-all aqui abriria rooms demais para um token forjado com
		// um papel arbitrário — o `role` vem do token, então é entrada do cliente.
		return false
	}
}
