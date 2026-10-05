package queue

import (
	"log"
	"os"
	"strings"
)

// Gate de posse da INGRESSÃO do webhook: este processo só drena a inbox se for o
// DONO de `POST /webhooks/pagarme` — ou seja, se o Caddy estiver apontando esse
// caminho para ele. Quem liga é `PAGARME_DRAIN`, desligada por padrão.
//
// ## O que o drain faz quando ligado
//
// Ele pega evento pendente e ENTREGA ao backend Node, que roda `applyCharge` na
// transação dele. Então ligado não significa "este processo decide o estado
// financeiro" — significa "este processo, e não o worker do Node, é quem chama o
// endpoint interno".
//
// ## Por que existe um gate, se o advisory lock já serializa
//
// `pdv:payment:worker` garante MÚTUA EXCLUSÃO entre drenadores e é o MESMO lock do
// worker do Node: os dois podem coexistir sem processar a mesma linha ao mesmo
// tempo. Não há, aqui, o defeito que o `WS_DISPATCH` do gateway WS precisa
// impedir.
//
// A janela perigosa é outra, e é de CONFIGURAÇÃO: se o Caddy já aponta
// `/webhooks/pagarme` para o Go, mas o backend Node ainda NÃO tem o endpoint
// interno (ou a `PAGARME_INTERNAL_TOKEN` divergiu), cada webhook gravado vira um
// 404/401, cada retry esgota o teto e a fila inteira vai para a DLQ. O sintoma é
// uma fila morta crescendo e NENHUMA confirmação de pagamento — que é o pior
// estado possível num sistema de caixa, e nada no log do gateway de pagamento
// denuncia que a culpa é de deploy.
//
// O gate fecha essa janela pela raiz, dentro do processo: sem `PAGARME_DRAIN=1` o
// drain não existe, e o `PAGARME_DRAIN` no compose (que o `profiles` segura) é só
// convenção de inicialização.
//
// ## A diferença de superfície para o `WS_DISPATCH`
//
// Lá, ligar o gate errado faz o gateway ENGOLIR evento de quem está conectado no
// outro servidor — e o evento morre marcado como publicado, sem erro. Aqui, ligar
// o gate errado faz este processo CHAMAR o endpoint interno e o Node recusar — e a
// recusa é visível (401/404 no log, linha em `failed`, contagem no `/health`).
//
// Ou seja: o gate existe, mas o modo de falha é ruidoso em vez de silencioso, e
// esse é o motivo de o `PAGARME_DRAIN` poder ser ligado mais cedo que o
// `WS_DISPATCH`. Ainda assim, default-deny por simetria e porque um valor
// mal digitado que LIGASSE o drain seria o mesmo defeito que o gate existe para
// impedir.
const drainEnv = "PAGARME_DRAIN"

// DrainEnabled diz se este processo pode drenar a inbox.
//
// Default-deny de propósito: valor vazio, `0`, `false` e qualquer coisa
// inesperada (inclusive `sim`) deixam o drain desligado. Um valor mal digitado que
// ligasse o gate seria o mesmo defeito que o gate existe para impedir, e não o
// oposto.
func DrainEnabled() bool { return envTruthy(os.Getenv(drainEnv)) }

// envTruthy é o parse das flags booleanas do serviço: só os quatro valores abaixo
// ligam. Aceitar qualquer string não-vazia faria `PAGARME_DRAIN=0` e um
// `PAGARME_DRAIN=` com espaço a mais ligarem o drain — o tipo de divergência
// silenciosa que ninguém vê até a fila de webhook deixar de ser processada.
//
// Mesma função, mesma lista e mesmo texto do `ws-gateway/internal/outbox/gate.go`:
// um `true` num serviço e `sim` no outro seria a pior divergência possível entre
// dois binários que se complementam.
func envTruthy(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// LogDrainInativo explica, uma vez no boot, por que a inbox não está sendo
// drenada. Existe porque o estado oposto é o insidioso: serviço saudável, banco
// respondendo, `/health` 200, `webhookOwned: true`, e nenhuma confirmação de
// pagamento — e o operador não tem onde olhar. A mensagem nomeia a env, o valor que
// foi lido e o passo do deploy em que ela deve ser ligada.
func LogDrainInativo(motivo string) {
	raw := os.Getenv(drainEnv)
	if strings.TrimSpace(raw) == "" {
		log.Printf("[queue] drain da inbox INATIVO (%s não definida) — este processo grava o evento na inbox mas não "+
			"processa; quem processa é o worker do backend Node. Motivo: %s. Ligar %s=1 só no deploy em que o Caddy "+
			"passa a apontar /webhooks/pagarme para este serviço, e depois que o endpoint interno do Node responder. "+
			"Ligar antes disso manda cada evento para a DLQ com 404 ou 401, e uma fila morta de confirmação de "+
			"pagamento é o pior estado possível num sistema de caixa.", drainEnv, motivo, drainEnv)
		return
	}
	log.Printf("[queue] drain da inbox INATIVO (%s=%q não é um valor de ligado) — este processo grava o evento na "+
		"inbox mas não processa; quem processa é o worker do backend Node. Motivo: %s. Ligar %s=1 só no deploy em que "+
		"o Caddy passa a apontar /webhooks/pagarme para este serviço.", drainEnv, raw, motivo, drainEnv)
}
