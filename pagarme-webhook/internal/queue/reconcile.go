package queue

import (
	"context"
	"database/sql"
	"log"
	"strings"
	"time"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/gateway"
	"pdv-pagarme-webhook/internal/nodeapi"
)

// DefaultReconciliationIntervalMS é o padrão de
// `PAGARME_RECONCILIATION_INTERVAL_MS` (10min, spec §22). O Node usa o mesmo
// valor (`config.pagarmeReconciliationIntervalMs`).
const DefaultReconciliationIntervalMS = 600_000

// ReconciliationLimit é o teto de cobranças relidas por ciclo, o `limit = 20` do
// `reconcilePendingPaymentsUsecase`.
//
// O teto existe porque cada item é uma chamada HTTP ao gateway com timeout de
// 15s: sem teto, 500 cobranças pendentes levariam 2 horas dentro do advisory lock
// e o drain de webhook pararia junto. Com 20 e intervalo de 10min, o pior caso
// de uma fila grande é atraso — nunca travamento.
const ReconciliationLimit = 20

// pendingStatuses são os status que a reconciliação relê, e a lista é a do Node
// (`reconcilePendingPaymentsUsecase`, payment.usecases.ts:737).
//
// Só `pending` e `processing`: uma cobrança já resolvida (`paid`, `failed`,
// `canceled`) não é relida, porque o estado local já é final e o gateway só criaria
// tráfego. `refunded` e `partially_refunded` ficam de fora por um motivo mais
// forte: reler um pedido estornado pode devolver `paid` de novo, e quem impede a
// reversão é a guarda de transição do Node (`canMoveTo`), não esta lista.
var pendingStatuses = []string{"pending", "processing"}

// Reconciler relê no gateway as cobranças que nenhum webhook confirmou.
//
// ## O que esta peça NÃO decide
//
// A guarda de transição. `canMoveTo` (`payment.usecases.ts:768`) é regra de
// domínio, e a leitura aqui pode estar DIAS atrasada — aplicar `paid` numa cobrança
// já `refunded` seria reverter dinheiro. Por isso o `Source` do pedido é
// `reconciliation`, e o Node aplica `canMoveTo` antes do `applyCharge`. Esta peça
// pergunta; o Node responde se o movimento é legítimo.
//
// ## Por que Go lê `payment` direto em vez de pedir a lista ao Node
//
// A lista é um SELECT puro sobre uma tabela que o Go já tem conexão, e não tem
// regra de domínio: os dois status são literais do enum `PaymentStatus` e o filtro
// não depende de nada calculado. Pedir a lista ao Node custaria um endpoint novo,
// um cliente HTTP novo, e transformaria o componente que existe para recuperar
// webhook perdido em dependente do componente que pode estar fora — a pior
// direção para a rede de segurança.
//
// O trade-off, com todas as letras: se um dia o predicado ganhar regra de
// domínio (ex.: "só relê se a loja tem o toggle ligado"), a leitura tem que vir do
// Node. Enquanto for um `WHERE`, divergir é inócuo — um conjunto maior só pergunta
// ao gateway sobre alguns ids a mais, e um menor só atrasa a recuperação, que o
// worker do Node continua fazendo enquanto existir.
type Reconciler struct {
	db      *sql.DB
	aplica  Aplica
	gateway GatewayFinder
	poll    time.Duration
	limit   int
}

// GatewayFinder é a parte do client do Pagar.me que a reconciliação usa.
//
// Interface mínima para o teste poder substituí-la por um dublê e exercitar a
// reconciliação sem rede: o que está em jogo é a CLASSIFICAÇÃO da resposta
// (achou / não achou / erro retryable) e o destino de cada uma.
type GatewayFinder interface {
	Find(ctx context.Context, providerOrderID string) (*charge.Charge, error)
}

// NewReconciler monta um Reconciler.
func NewReconciler(db *sql.DB, aplica Aplica, gateway GatewayFinder) *Reconciler {
	return &Reconciler{
		db:      db,
		aplica:  aplica,
		gateway: gateway,
		poll:    DefaultReconciliationIntervalMS * time.Millisecond,
		limit:   ReconciliationLimit,
	}
}

// DefinirIntervalo ajusta a cadência depois da construção.
//
// Existe para o `PAGARME_RECONCILIATION_INTERVAL_MS` chegar do `main` sem que o
// construtor tenha de ler `os.Getenv` — a mesma separação do `queue.DrainEnabled`,
// que o `main` decide e não o pacote. Um valor não positivo é ignorado em vez de
// virar `time.NewTicker(0)`, que é um panic imediato: a env com typo não pode
// derrubar o processo no boot.
func (r *Reconciler) DefinirIntervalo(d time.Duration) {
	if d <= 0 {
		return
	}
	r.poll = d
}

// Intervalo devolve a cadência em uso. Existe para o log de boot e para o teste
// poderem conferir que a env chegou.
func (r *Reconciler) Intervalo() time.Duration { return r.poll }

// Run faz a reconciliação até o ctx ser cancelado, no intervalo configurado.
//
// Um ciclo no boot antes do primeiro tick, como no drain: sem isso, um webhook
// perdido durante uma janela de deploy só é recuperado 10 minutos depois do
// primeiro tick.
func (r *Reconciler) Run(ctx context.Context) {
	// A reconciliação é a OUTRA ponta que fala com o Node, e usa o mesmo gate:
	// ela entrega cobrança ao endpoint interno, e um Node sem endpoint (ou com
	// token divergente) transformaria cada ciclo em N chamadas recusadas. Ligar a
	// reconciliação sem o drain ligado não faz sentido nenhum — quem processa
	// evento é o drain.
	if !DrainEnabled() {
		LogDrainInativo("PAGARME_DRAIN desligado (a reconciliação segue o drain: sem ele, o worker do Node é quem processa)")
		return
	}

	ticker := time.NewTicker(r.poll)
	defer ticker.Stop()

	if checked, _, err := r.ReconcileOnce(ctx); err != nil && ctx.Err() == nil {
		log.Printf("[queue] erro no primeiro ciclo de reconciliação: %v", err)
	} else if ctx.Err() == nil {
		log.Printf("[queue] primeira reconciliação: %d cobrança(s) pendente(s)", checked)
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("[queue] reconciliação parada")
			return
		case <-ticker.C:
			if _, _, err := r.ReconcileOnce(ctx); err != nil && ctx.Err() == nil {
				log.Printf("[queue] erro no ciclo de reconciliação: %v", err)
			}
		}
	}
}

// pendingSelect é a lista de pendentes, e é o predicado do Node palavra por
// palavra (`inArray(payments.status, ["pending","processing"])` + `provider`).
//
// `provider_order_id IS NOT NULL` é o filtro que o Node faz em código (`if
// (!row.providerOrderId) continue`, payment.usecases.ts:743): criação que nem
// chegou no gateway não tem o que reler. Ele está no `WHERE` para não puxar
// linhas que seriam descartadas logo depois.
//
// `created_at` aparece no `ORDER BY` e não na lista de colunas, e isso é válido
// em SQL — o `ORDER BY` não precisa ser uma coluna projetada.
//
// O `::text[]` no `$1` é necessário e não é decoração: sem o cast, o Postgres não
// consegue inferir o tipo do parâmetro de `= ANY(...)` e a query falha com
// "could not determine data type of parameter $1" — que derrubaria a reconciliação
// INTEIRA, em todo ciclo, com o evento dando a volta completa a cada 10 minutos.
const pendingSelect = `SELECT id, provider_order_id
	FROM payment
	WHERE provider = 'pagarme'
	  AND status = ANY($1::text[])
	  AND provider_order_id IS NOT NULL
	ORDER BY created_at ASC
	LIMIT $2`

// ReconcileOnce é um ciclo de reconciliação. Devolve quantas cobranças foram
// lidas e quantas mudaram.
func (r *Reconciler) ReconcileOnce(ctx context.Context) (checked, changed int, err error) {
	// O advisory lock da reconciliação é SEPARADO do do drain: são trabalhos
	// diferentes, e no mesmo lock um ciclo de reconciliação (que segura o lock
	// durante até 20 chamadas HTTP de 15s) atrasaria o webhook. Mesmo desenho do
	// Node, que tem `LOCKS.paymentReconciliation` para isto.
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() // no-op se já commitou

	var locked bool
	if err := tx.QueryRowContext(ctx,
		`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockReconciliation).Scan(&locked); err != nil {
		return 0, 0, err
	}
	if !locked {
		// Outro processo reconciliando. Não é erro — e aqui não há o risco do
		// realtime: os dois fazem exatamente a mesma pergunta e recebem a mesma
		// resposta, e o `applyCharge` do Node é idempotente.
		return 0, 0, nil
	}

	rows, err := tx.QueryContext(ctx, pendingSelect, textArray(pendingStatuses), r.limit)
	if err != nil {
		return 0, 0, err
	}
	type pendente struct {
		id              string
		providerOrderID string
	}
	var lista []pendente
	for rows.Next() {
		var p pendente
		if err := rows.Scan(&p.id, &p.providerOrderID); err != nil {
			rows.Close()
			return 0, 0, err
		}
		lista = append(lista, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()

	for _, p := range lista {
		checked++
		if r.reconcilia(ctx, p.id, p.providerOrderID) {
			changed++
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return checked, changed, nil
}

// reconcilia relê UMA cobrança no gateway e entrega ao Node.
//
// Devolve `true` se o Node aplicou a mudança.
func (r *Reconciler) reconcilia(ctx context.Context, paymentID, providerOrderID string) bool {
	charge, err := r.gateway.Find(ctx, providerOrderID)
	if err != nil {
		// Falha de rede/gateway em UMA reconciliação não pode derrubar o ciclo:
		// as outras cobranças da fila precisam ser vistas. Mesmo `catch` por
		// cobrança do Node, e o aviso vai para o log porque é o único lugar que
		// registra que a reconciliação está às cegas.
		if e, ok := gateway.AsError(err); ok && e.Retryable {
			log.Printf("[queue] falha TEMPORÁRIA ao reconciliar %s (a próxima tentativa vem no próximo ciclo): %v",
				providerOrderID, err)
		} else {
			log.Printf("[queue] falha ao reconciliar %s: %v", providerOrderID, err)
		}
		return false
	}
	if charge == nil {
		// `find` devolve `nil` em 404, que é "o gateway não conhece esse id" —
		// resultado normal, não erro. A cobrança fica como está e o próximo
		// ciclo tenta de novo (pedido que saiu do dashboard do gateway volta a
		// aparecer, e aí é resolvido).
		log.Printf("[queue] o gateway não conhece a cobrança %s (%s) — deixando como está", providerOrderID, paymentID)
		return false
	}

	res, err := r.aplica.ApplyCharge(ctx, nodeapi.Request{
		ProviderOrderID:   charge.ProviderOrderID,
		ProviderPaymentID: charge.ProviderPaymentID,
		Source:            nodeapi.SourceReconciliation,
		Charge:            nodeapi.NewChargePayload(charge),
	})
	if err != nil {
		// Também não derruba o ciclo: uma falha aqui é do Node ou da rede, e as
		// outras cobranças da fila continuam precisando ser vistas. O estado da
		// cobrança não muda por isso — quem mudaria é o `applyCharge`, que não
		// rodou.
		log.Printf("[queue] backend Node recusou a reconciliação de %s: %v", providerOrderID, err)
		return false
	}
	if !res.Applied {
		// `no_transition`: o gateway diz um estado que não pode ir para onde a
		// cobrança já está. É a guarda do Node funcionando, e o caso mais comum
		// num ciclo normal — por isso é informativo, não alarme.
		log.Printf("[queue] reconciliação de %s não moveu a cobrança: %s", providerOrderID, res.Reason)
		return false
	}
	log.Printf("[queue] reconciliação aplicou %s em %s (status %s)", providerOrderID, paymentID, res.Status)
	return true
}

// CountDeadLettered devolve quantos eventos estão presos na DLQ
// (`status = 'failed' AND next_attempt_at IS NULL`).
//
// Espelha o `countDeadLetteredEvents` do Node (worker.ts:130). Aqui ele é
// EXPORTADO de propósito: é o número que o `/health` mostra, e é o único que
// denuncia sozinho que a fila morta está crescendo — sem ele, a DLQ é invisível
// até alguém abrir a tabela.
func (r *Reconciler) CountDeadLettered(ctx context.Context) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx,
		`SELECT count(*) FROM payment_event WHERE status = 'failed' AND next_attempt_at IS NULL`).Scan(&n)
	return n, err
}

// textArray monta o literal de array do Postgres para a lista de status.
//
// `database/sql` com `lib/pq` não tem tipo "array de texto" pronto, e usar
// `pq.Array` obrigaria este pacote a importar o driver direto — e a dependência
// ficaria espalhada por dois pacotes em vez de viver só em `internal/db`.
//
// O literal é mais simples e tem menos superfície: os valores são literais do
// domínio (`pending`, `processing`), nunca entrada de usuário.
//
// ## Aspas DUPLAS, e não simples — medido
//
// O parser de array do Postgres desempacota aspas DUPLAS e as remove; as simples
// NÃO são especiais e entram no valor da string. Com aspas simples o que volta do
// `SELECT array_to_string($1::text[], ',')` é literalmente `'pending','processing'`
// (com os apóstrofos dentro), e `status = ANY(...)` não casa com `pending` de
// nenhum jeito — a reconciliação rodaria, sem erro, e não leria uma linha só. É a
// falha mais cara que existe aqui: silenciosa, e o sintoma é "a reconciliação
// nunca roda" em vez de "a reconciliação está quebrada".
//
// O escape é o do parser de array: `\` vira `\\` e `"` vira `\"`.
func textArray(values []string) string {
	if len(values) == 0 {
		return "{}"
	}
	quoted := make([]string, 0, len(values))
	for _, v := range values {
		var b strings.Builder
		b.WriteByte('"')
		for _, c := range v {
			if c == '"' || c == '\\' {
				b.WriteByte('\\')
			}
			b.WriteRune(c)
		}
		b.WriteByte('"')
		quoted = append(quoted, b.String())
	}
	return "{" + strings.Join(quoted, ",") + "}"
}
