package outbox

import (
	"log"
	"os"
	"strings"
)

// Gate de posse do realtime: este processo só despacha `outbox_event` se for o
// DONO das conexões WebSocket — ou seja, se o Caddy estiver apontando
// `/realtime*` para ele. Quem liga é `WS_DISPATCH`, desligada por padrão.
//
// ## Por que o advisory lock não resolve isto
//
// `pdv:outbox:owner` (ver lockName) é um MUTEX entre dispatchers, e só isso.
// Ele garante que, num dado ciclo, no máximo um processo leia o lote e escreva
// `published = true` — nada mais. Ele não sabe, e não tem como saber, qual
// processo é o dono do `/realtime`: essa informação está no Caddy, não no
// banco. Venceu o lock, o ciclo marca publicado do mesmo jeito, com ou sem
// assinante na room (paridade com o Node, ver Dispatcher.publish).
//
// A consequência de o vencedor ser um processo que não é o dono: um gateway no
// ar que NÃO está no caminho do `/realtime` ganha cerca de metade dos ciclos,
// engole os eventos de quem está conectado no Node e marca `published = true`.
// Não há erro em log nenhum e o banco não denuncia — o evento não está mais
// pendente. O sintoma é o sino do salão que não toca e a tela do garçom que
// só recompõe no F5 seguinte (o `useRealtime` ressincroniza por REST na
// reconexão). Foi medido: gateway de pé, zero clientes, linha pendente em
// menos de 2s (o poll é de 200ms).
//
// ## Por que desligada por padrão, e não ligado pelo deploy
//
// O serviço já vive atrás de `profiles: ["ws-gateway"]` no compose, que o
// mantém fora do `up` normal. Isso segura o caso comum, mas não o perigoso:
// ligar o perfil para preparar a virada faz o container subir e começar a
// disputar o lock com o Node ANTES do Caddy apontar `/realtime` para ele — a
// janela em que o gateway rouba evento é a mesma em que ele parece inofensivo
// (ninguém conectado nele). O gate fecha essa janela pela raiz, dentro do
// processo: sem `WS_DISPATCH=1` o dispatcher simplesmente não existe, e o
// perfil do compose volta a ser só convenção de inicialização.
//
// ## Por que dentro do pacote e não no `main.go`
//
// A decisão é do dispatcher, não do servidor: `Run` e `PollOnce` são os únicos
// caminhos que escrevem `published = true`, e quem protege esse caminho
// protege-se a si mesmo. Assim o `cmd/gateway` não precisa lembrar de
// perguntar antes de chamar, e um teste novo não consegue publicar sem o gate.
const dispatchEnv = "WS_DISPATCH"

// DispatchEnabled diz se este processo pode despachar o outbox. Fica exportado
// para o `/health` do gateway não mentir: "tenho banco, logo publico" é falso
// com o gate desligado, e o `/health` é o portão do deploy (docs/agent-deploy.md).
//
// Default-deny de propósito: valor vazio, `0`, `false` e qualquer coisa
// inesperada (inclusive `sim`) deixam o dispatcher desligado. Um valor mal
// digitado que ligasse o gate seria o mesmo defeito que o gate existe para
// impedir, e não o oposto.
func DispatchEnabled() bool { return envTruthy(os.Getenv(dispatchEnv)) }

// envTruthy é o parse das flags booleanas do serviço: só os quatro valores
// abaixo ligam. Aceitar qualquer string não-vazia faria `WS_DISPATCH=0` e um
// `WS_DISPATCH=` com espaço a mais ligarem o dispatcher — o tipo de divergência
// silenciosa que ninguém vê até o bell do salão parar.
func envTruthy(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// logInactive explica, uma vez no boot, por que o dispatcher não está
// publicando. Existe porque o estado oposto é o insidioso: gateway saudável,
// banco respondendo, `outboxEnabled:true` no `/health` e nenhum evento — e o
// operador não tem onde olhar. A mensagem nomeia a env, o valor que foi lido e
// o passo do deploy em que ela deve ser ligada, para não ser preciso abrir o
// código para descobrir o porquê.
func logInactive() {
	raw := os.Getenv(dispatchEnv)
	if strings.TrimSpace(raw) == "" {
		log.Printf("[outbox] dispatcher INATIVO (%s não definida) — este processo não é o dono do /realtime, "+
			"então não publica nada (o dispatcher do backend Node é quem está com as conexões). Publicar daqui "+
			"roubaria os eventos de quem está conectado lá: o advisory lock %s só dá exclusão entre dispatchers, "+
			"não exclusividade de dono, e o evento cairia em published=true sem ninguém ter recebido. "+
			"Ligar %s=1 só no deploy em que o Caddy passa a apontar /realtime para o gateway.", dispatchEnv, lockName, dispatchEnv)
		return
	}
	log.Printf("[outbox] dispatcher INATIVO (%s=%q não é um valor de ligado) — este processo não é o dono do "+
		"/realtime, então não publica nada. Ligar %s=1 só no deploy em que o Caddy passa a apontar /realtime "+
		"para o gateway; ver gate.go para o porquê.", dispatchEnv, raw, dispatchEnv)
}
