# Serviço Go do webhook do Pagar.me — Especificação

Componente do PDV: **recebe** o webhook do gateway de pagamento, grava na inbox e
**processa** de forma assíncrona. Mora junto do código (fora de `docs/`) porque é
spec de um componente, não do produto inteiro — mesmo critério do
`ws-gateway/GO-GATEWAY-PLAN.md`, que é o precedente deste.

---

## Visão geral

O backend Node (`backend/src/integrations/pagarme/`) faz hoje duas coisas na
receita do webhook: **gravar o evento** na tabela `payment_event` e **drenar** essa
tabela, chamando o gateway. Este serviço assume as duas, mais a reconciliação.

O que **não** vem: o estado de domínio. Toda escrita de `payment` — e o
`audit_log`/`outbox_event` que vem junto — continua no Node.

### A regra que organiza o sistema inteiro

> **Go NUNCA fica no caminho síncrono de um request de usuário, e nunca escreve
> estado de domínio.**

Não é preferência de camada: é o que impede duas implementações da regra
financeira contra o mesmo banco. `applyCharge` decide o que cada status faz com
`paidAmount`, `refundedAmount` e `qrCode`; `bridgePaidToOrder` decide se a linha
em `order_payment` já existe; `logAction` escreve `audit_log` + `outbox_event` na
mesma transação. Reproduzir isso em Go daria duas regras que divergem em silêncio,
e divergência em regra financeira é o pior tipo de bug que existe — não dá erro,
dá dinheiro no lugar errado.

---

## Arquitetura

```
                      POST /webhooks/pagarme
   Pagar.me  ──────────────────────────────────►  Caddy
                    (HMAC-SHA1 do corpo cru)        │
                                                    │ /webhooks/pagarme*  → PDV_PAGARME_UPSTREAM
                                                    ▼
                                    ┌───────────────────────────────┐
                                    │   GO: pagarme-webhook :8080   │
                                    │                               │
                                    │  signature.Verify(corpo cru)  │
                                    │            ↓                  │
                                    │  inbox.Store.Record           │──► payment_event (ON CONFLICT)
                                    │            ↓                  │
                                    │  ─── respond 200 ───►         │
                                    └───────────────────────────────┘
                                                     │
                            a cada 2s, drain     │  pg_try_advisory_xact_lock('pdv:payment:worker')
                            (batch 25)            ▼
                                    ┌───────────────────────────────┐
                                    │  queue.Drainer               │
                                    │  mapOrderToCharge (payload)  │
                                    │  attempts / backoff / DLQ    │──► payment_event (status, attempts,
                                    └───────────────────────────────┘    next_attempt_at)
                                                     │
                                                     │ POST /internal/pagarme/events/:id/apply
                                                     │  X-Internal-Token: <token>
                                                     ▼
                                    ┌───────────────────────────────┐
                                    │  BACKEND NODE                 │
                                    │  applyCharge   ← regra       │──► payment, audit_log,
                                    │  bridgePaidToOrder  de        │    outbox_event, order_payment
                                    │  logAction      domínio       │    (tudo na MESMA transação)
                                    └───────────────────────────────┘

   Reconciliação (a cada PAGARME_RECONCILIATION_INTERVAL_MS):
     Go: SELECT ... FROM payment (pendentes) ─► GET /orders/{id} no Pagar.me
         ─► POST /internal/pagarme/charges/apply ─► Node (canMoveTo + applyCharge)
```

**Por que o Go pede ao Node em vez de escrever.** Escrever direto exigiria
duplicar `applyCharge` + `bridgePaidToOrder` + `logAction` — três regras de
domínio — em Go. Pedir custa uma chamada HTTP local e mantém **uma** implementação
da regra financeira. O preço é a serialização e a latência de rede interna, que
aqui é de menos de um milissegundo.

---

## O que fica em cada lado

| Peça | Onde | Por quê |
|---|---|---|
| `POST /webhooks/pagarme` | **Go** | I/O puro: validar HMAC, gravar, responder |
| Validação da assinatura | **Go** | I/O puro, sem estado |
| `mapOrderToCharge`, `mapStatus` | **Go** | Tradução de formato, sem regra (regra 1 do `mapper.ts`) |
| Drenagem: `attempts`, `next_attempt_at`, backoff, DLQ | **Go** | Temporização e contagem — é I/O com relógio |
| `pg_try_advisory_xact_lock('pdv:payment:worker')` | **Go** (mesma chave) | Serialização entre instâncias |
| Reconciliação: *quais* ids reler, `GET /orders/{id}` | **Go** | I/O externo |
| Reconciliação: *pode* ir para esse estado? (`canMoveTo`) | **Node** | Regra de domínio pura |
| `applyCharge`, `bridgePaidToOrder`, `settleRefunds` | **Node** | Regra de domínio + transação |
| `audit_log`, `outbox_event` | **Node** | Mesmo formato, mesma transação |
| `payment` (criação, cancelamento, estorno) | **Node** | O pedido e o registro local são a mesma decisão |
| Os 5 endpoints REST de pagamento | **Node** | Autenticados, síncronos, caminho de usuário |
| `store_settings.pagarme_enabled` | **Node** | Toggle do dono da loja, no banco |

---

## Formato da fila

`payment_event` é a fila, e o ciclo é o de `worker.ts` (`drainInboxOnce`):

| `status` | `next_attempt_at` | Significado |
|---|---|---|
| `received` | `NULL` | elegível agora |
| `failed` | `< agora` | esperando o backoff vencer |
| `failed` | futuro | aguardando o backoff |
| `failed` | `NULL` | **DLQ** — fora da fila, à vista |
| `processing` | — | **nunca elegível** (ver abaixo) |
| `processed` / `ignored` | — | terminais |

### Por que `processing` fica de fora

Um evento marcado `processing` que o processo não terminou é resgatado pela
**reconciliação**. Pegá-lo aqui criaria dois consumidores da mesma linha — e como o
apply roda no Node (outro processo), o que se sobreporia são duas transações de
`applyCharge` concorrentes na mesma cobrança, disputando `paymentConfirmedAt` e a
inserção em `order_payment`. A reconciliação é o caminho de recuperação, e ela é
periódica: um evento preso em `processing` aparece na reconciliação em no máximo
10 minutos.

### Backoff

```
min(2^tentativas × 30s, 15min)
```

Tentativa 1 → 60s, 2 → 120s, 3 → 240s, 4 → 480s, 5 → **DLQ**
(`MaxAttempts = 5`, o `MAX = 5` do `requeueFailedEventUsecase`).

### Bug do Node encontrado por este trabalho

`requeueFailedEventUsecase` (`payment.usecases.ts:711`) grava `status: 'received'`
**com** `next_attempt_at` preenchido. A elegibilidade do Node
(`worker.ts:102`) é:

```
(status = 'received' AND next_attempt_at IS NULL)     -- evento novo
OU (status = 'failed' AND next_attempt_at <= agora)  -- backoff vencido
```

Uma linha `received` com `next_attempt_at` **não satisfaz nenhum dos dois ramos**.
Ou seja: o reenfileiramento do Node nunca é lido de volta, e a janela de retry do
worker dele está morta na prática — a primeira falha tira o evento da fila para
sempre, sem ser DLQ, sem `attempts` batendo o teto e **sem nada no log que
denuncie**.

Aqui o reenfileiramento grava `failed`, que satisfaz o segundo ramo, e o retry
funciona de verdade nos dois sentidos (os dois workers leem linhas escritas pelo
outro). O conserto do Node é remover o `isNull` do predicado dele — fica para o
PR de lá.

---

## Contrato com o Node (proposto)

### `POST /internal/pagarme/events/:eventId/apply`

`:eventId` é o **`payment_event.id`** (UUID local), **não** o `event_id` do
gateway. O provedor reenvia o mesmo `event_id`, e usá-lo na URL faria a segunda
entrega ser um dedupe ao invés de uma reaplicação idempotente.

```
Headers:
  X-Internal-Token: <PAGARME_INTERNAL_TOKEN>
  Content-Type: application/json

Body:
{
  "eventId":           "uuid-da-linha-da-inbox",
  "eventType":         "order.paid",
  "providerOrderId":   "or_...",
  "providerPaymentId": "pay_...",
  "source":            "event",
  "charge": {                       // GatewayCharge, o mesmo do mapper
    "providerOrderId":   "or_...",
    "providerChargeId":  "ch_...",  // opcional
    "providerPaymentId": "pay_...", // opcional
    "status":            "paid",    // PaymentStatus, já traduzido
    "amount":            45.90,     // reais
    "paidAmount":        45.90,     // opcional (ausente ≠ 0)
    "refundedAmount":    10.00,     // opcional
    "pix": {                       // opcional
      "qrCode": "...", "qrCodeBase64": "...",
      "qrCodeUrl": "...", "txid": "...", "expiresAt": "..."
    },
    "cardLast4": "4242",            // opcional
    "cardBrand": "visa"             // opcional
  }
}

Respostas:
  200 {"applied": true, "status": "paid"}
      → a transação do Node rodou; o evento já está `processed` (ou `ignored`)
  200 {"applied": false, "reason": "no_transition"}
      → a guarda recusou (ex.: gateway ainda diz `pending` para cobrança já
        `paid`). NORMAL na reconciliação; sem retry
  404 → não casou com nenhuma cobrança nossa, ou a linha da inbox não existe
  401 → token ausente ou errado
  409/422 → requisição recusada (status fora do vocabulário, payload sem id)
  5xx → infraestrutura; o Go dá retry com backoff
```

### `POST /internal/pagarme/charges/apply`

Mesmo corpo, sem `eventId`/`eventType`, com `"source": "reconciliation"`.

Por que dois caminhos e não um: a diferença não é de rota, é de **guarda**.
`applyCharge` grava direto no caminho do webhook (o evento chega na hora e não há
estado intermediário confiável para checar), mas a reconciliação relê o gateway
com a leitura podendo estar **dias** atrasada — e aplicar `paid` numa cobrança já
`refunded` seria reverter dinheiro. `source` é o que faz o Node escolher
`canMoveTo` (`payment.usecases.ts:768`).

### Idempotência — o requisito que NÃO é novo

O Go entrega **at-least-once**. O cenário concreto: o apply do Node faz commit, e o
`UPDATE` de bookkeeping do Go (na transação que segura o advisory lock) **rola** —
o evento volta a ser elegível e é processado de novo.

A segurança está no Node, e já existe:

- `applyCharge`: `if (alvo === atual) return row` — o segundo apply do mesmo
  status é no-op (`payment.usecases.ts:516`);
- `bridgePaidToOrder`: não cria a linha em `order_payment` se já existe uma
  confirmada do mesmo `(method, amount)` (`:600`);
- `logAction` só roda quando o status de fato mudou (`:555`).

O que o endpoint interno precisa é **não introduzir um caminho que escape disso**.
Dois pontos que o lado Node tem que respeitar:

1. **Validar `charge.status` contra o vocabulário** antes de `applyCharge`. Hoje o
   payload vem do mapper (que só produz `PaymentStatus` válido); pelo endpoint ele
   vem por **rede**, e um `status` desconhecido viraria um `UPDATE payments SET
   status = '<lixo>'` — sem erro, e a linha sai do vocabulário do domínio.
2. **Não marcar o evento `processed` sem a transação ter commitado.**

### Tabela de destino de erro (o que o Go faz com cada resposta)

| Resposta | Destino | Por quê |
|---|---|---|
| 200 `applied:true` | — | o Node já marcou a linha na transação dele |
| 200 `applied:false` | — | guarda de transição funcionando |
| 5xx / 429 / rede / timeout | `failed` + `next_attempt_at` futuro; DLQ no teto | transitório |
| 401 / 403 | **DLQ imediata** + log citando `PAGARME_INTERNAL_TOKEN` | repetir com o mesmo token nunca funciona |
| 409 / 422 | **DLQ imediata** | o conteúdo do evento não muda com o tempo |
| 404 | `ignored` (terminal, **não** DLQ) | "chegou coisa que não era nossa" — e fica visível na inbox |
| payload que o mapper não entende | **DLQ imediata**, sem chamar o Node | quebra em toda tentativa; a reconciliação resolve |

### Reconciliação: por que Go lê `payment` direto

**Decisão: opção (a)** — o Go lê a tabela `payment` do Postgres.

```sql
SELECT id, provider_order_id FROM payment
WHERE provider = 'pagarme'
  AND status = ANY('{"pending","processing"}')
  AND provider_order_id IS NOT NULL
ORDER BY created_at ASC
LIMIT 20
```

Três razões:

1. **É o mesmo banco.** Zero chamada nova, zero latência, zero novo ponto de
   falha. O `ws-gateway` já lê `outbox_event` direto — é o precedente do repo.
2. **Não tem regra de domínio.** Os dois status são literais do enum
   `PaymentStatus`; o filtro não depende de nada calculado. O que é regra
   (`canMoveTo`) fica no Node, e é lá que decide.
3. **A direção da dependência.** Pedir a lista ao Node (opção b) transformaria o
   componente que existe para **recuperar** webhook perdido em dependente do
   componente que pode estar fora — que é a pior direção para uma rede de
   segurança. Se o Node está fora, a reconciliação é justamente a que mais
   precisa rodar.

**Trade-off, dito com todas as letras.** Se um dia o predicado ganhar regra de
domínio (ex.: "só relê se a loja tem o toggle ligado"), a leitura tem que vir do
Node e a opção (b) vira obrigatória. Enquanto for um `WHERE`, divergir entre as
duas listas é inócuo: um conjunto maior só pergunta ao gateway sobre alguns ids a
mais; um menor só atrasa a recuperação, e o worker do Node continua fazendo
enquanto existir. **Essa é a linha a reavaliar** quando o predicado mudar.

---

## Gate de posse (`PAGARME_DRAIN`)

Default-deny, igual ao `WS_DISPATCH`. **Desligado** = este processo **grava** o
evento na inbox (o dedupe acontece, o `/health` fica verde) mas **não processa**:
quem processa é o worker do Node, na mesma tabela, com o mesmo advisory lock.

### Por que aqui o gate é menos crítico que no realtime

O `WS_DISPATCH` protege de um defeito **silencioso**: um gateway que não é o dono
do `/realtime` marca `published = true` e o evento morre sem ninguém ter recebido.

No webhook, o drain **não marca nada** — quem marca `processed` é o Node, dentro da
transação dele. Um drain ligado sem o endpoint interno produz 401/404 **visíveis**:
log em nível de erro citando a env, linha em `failed`, contagem no `/health`. A
fila morta é o sintoma, e ela aparece sozinha.

O gate existe para a **janela de deploy**, não para o estado estável: subir o
container e ligar `PAGARME_DRAIN` antes de o backend ter o endpoint manda a fila
inteira para a DLQ. `PAGARME_DRAIN=1` só no deploy em que o endpoint já responde.

### Ordem recomendada de virada (três passos, cada um reversível)

| Passo | Ação | Estado |
|---|---|---|
| 1 | `docker compose --profile pagarme-webhook up -d`, `PAGARME_WEBHOOK_BACKEND=node`, drain desligado | serviço de pé e **inativo**; Node é o dono de tudo |
| 2 | `PAGARME_WEBHOOK_BACKEND=go` + `caddy reload` | Go **grava** a inbox; Node **processa** |
| 3 | `PAGARME_DRAIN=1` | Go **processa**; Node disputa o mesmo lock e perde o ciclo em silêncio |

Os passos 1 e 2 são reversíveis em segundos (uma variável e um `reload`). O passo
3 também — mas derrubar a fila depois de cheio é o que dói.

---

## Ambiente

| Variável | Default | Efeito |
|---|---|---|
| `PORT` | `8080` | porta HTTP |
| `DATABASE_URL` | — | sem ela o serviço sobe mudo e o `/health` é 503 |
| `PAGARME_SECRET_KEY` | — | **a mesma do Node**; ausente ⇒ todo webhook 503 |
| `PAGARME_BASE_URL` | `https://api.pagar.me/core/v5` | sandbox é `sdx-api.pagar.me/core/v5` |
| `NODE_INTERNAL_URL` | `http://backend:3000` | onde está o backend |
| `PAGARME_INTERNAL_TOKEN` | — | ausente ⇒ o drain não sobe |
| `PAGARME_DRAIN` | desligado | default-deny (`1\|true\|yes\|on`) |
| `PAGARME_RECONCILIATION_INTERVAL_MS` | `600000` | 10 min |
| `GIT_SHA` | `dev` | aparece no `/health` |

`?sslmode=disable` é **obrigatório** no default do compose: o driver é o `lib/pq`,
que assume `sslmode=require` quando a DSN não diz nada, e o Postgres do compose não
tem TLS. Sem o parâmetro o serviço sobe **sem pool** — `/health` 503, log de aviso,
e cada webhook 503.

---

## `/health`

Portão do deploy, e o `switch.sh` **não** espera este serviço (o `wait_healthy`
cobre backend e frontend). O healthcheck do container é o que impede o compose de
marcar o serviço pronto antes de ele conseguir gravar.

| Campo | Significado |
|---|---|
| `webhookEnabled` | tem credencial **E** tem banco — as duas condições para gravar |
| `drainEnabled` / `webhookOwned` | o gate `PAGARME_DRAIN`, lido a cada chamada |
| `databaseLastOkSeconds` | `null` enquanto o banco nunca respondeu, `0` se acabou de responder |
| `databaseError` | erro do driver, ou "banco sem responder: último ping bom foi há Ns" |

**503** quando: banco indisponível, banco travado, ou sem `PAGARME_SECRET_KEY`.
**200** com `PAGARME_DRAIN` desligado — é o estado normal de subida lado a lado.

A diferença em relação ao `ws-gateway` (que responde 200 sem pool para permitir
rollback) é deliberada: aqui o serviço recusa **todo** webhook nesses estados, então
um 200 mandaria tráfego para um 503 em cada requisição. E o rollback é o inverso do
gateway WS — basta o Caddy voltar a apontar `/webhooks/pagarme` para o Node, e o
worker dele reassume a fila sem depender deste processo.

O probe de fundo (1s, `maxInFlight` 2, `staleAfter` 3s) existe porque
`PingContext` pode bloquear para sempre mesmo com contexto com deadline: o
cancelamento do `lib/pq` é entregue numa conexão TCP **nova**, que contra um banco
congelado trava tanto quanto a query original. O que decide o prazo é o **tempo**,
não o driver.

---

## Divergências conscientes do Node

| Onde | Node | Go | Por quê |
|---|---|---|---|
| evento sem `event_id` | **503** | **400** | o evento nunca será gravado; 503 faz o Pagar.me reenviar para sempre sem que nada mude |
| corpo não-UTF-8 | (vai pro banco) | **400** | `payload` é TEXT e o Postgres recusa byte inválido — o 503 resultante também seria reenvio infinito, com mensagem de banco no log |
| reenfileiramento | `received` + data | `failed` + data | ver §"Bug do Node encontrado por este trabalho" |
| `payload` gravado | `JSON.stringify(payload)` (re-serializado) | corpo **cru** | o re-serializar perde ordem de chave, grafia de número e `\u`; o cru é a **prova** do que o gateway mandou, e o único consumidor é `JSON.parse` |
| `attempts` | só o `processPaymentEvent` | os dois lados | quem reprova pode ser a aplicação Node (dentro do apply) ou a infraestrutura (fora). Encurta a DLQ em meio ciclo no máximo, nunca a alonga |
| `GET` no webhook | — | **405** | o Node não checa método e cairia no caminho de "corpo vazio", respondendo 401 — um 401 que não significa nada |
| `null` como corpo | aceito (zera a struct) | **400** | `json.Unmarshal("null", &struct)` **não dá erro**; um evento cego passaria como "sem id" |

### Defeito encontrado por smoke test (já corrigido, aqui)

O `main` montava o `Server` com um `*inbox.Store` nil quando o pool não conectava.
Passar um ponteiro nil para um parâmetro de **interface** produz uma interface
**não-nil** com ponteiro nil dentro: o `s.inbox == nil` do handler passa, e o
primeiro `s.db` estoura com `nil pointer dereference`.

O sintoma em produção seria: `/health` verde (o healthcheck segura), e o webhook
falhando **só quando a assinatura é válida** — porque a assinatura inválida desvia
antes do store. O Pagar.me reenviaria para sempre contra um serviço que parece
saudável, e o único sinal seria um stack trace no log do container.

Nenhum teste unitário pegou: os dublês da suíte são implementações reais da
interface. Só o binário de verdade, com `DATABASE_URL` ausente, entra no caminho.

---

## Checklist

- [x] Estrutura de pastas (mesma do `ws-gateway`)
- [x] `verifyWebhookSignature` com paridade de decisão (prefixo, caixa, regex de 40, tempo constante)
- [x] `mapStatus` e `mapOrderToCharge` com o switch exaustivo e o `null`→`(ok=false)`
- [x] Inbox com `ON CONFLICT (provider, event_id)` e `created_at` no formato do Node
- [x] `payment_id` sempre NULL (a coluna não entra no `INSERT`)
- [x] Sem credencial ⇒ 503, nunca 200
- [x] Reenvio ⇒ 200 com `duplicate:true`, nunca 4xx
- [x] Drain com backoff, DLQ e `processing` não selecionável
- [x] Advisory lock com o MESMO literal do Node (`pdv:payment:worker`), `xact_lock` e não de sessão
- [x] Reconciliação com `find()` no gateway e lista de pendentes no mesmo banco
- [x] Gate `PAGARME_DRAIN` default-deny
- [x] `/health` com probe de fundo e 503 em banco travado
- [x] Dockerfile multi-stage, `CGO_ENABLED=0`, usuário sem root, `ca-certificates`
- [x] Testes: assinatura, inbox, mapper, rotas, fila, contrato com o Node
- [x] **Smoke test do binário de verdade** contra Postgres real e um stub do endpoint interno: assinatura, dedupe, drain, backoff, DLQ (5 tentativas), retry após destravar, `/health`, gate, e o 503 sem credencial e sem banco. Foi ele que encontrou o panic do item seguinte
- [x] `.env.example` com o porquê e o momento de ligar
- [x] `docker-compose.yml` com `profiles`, sem `ports:`, sem volumes, healthcheck, `stop_grace_period`
- [x] `Caddyfile` com bloco próprio para `/webhooks/pagarme*` (verificado: a ordem **não** é o que decide, o adapter ordena por especificidade)
- [x] `caddy-assemble.sh` com `PDV_PAGARME_UPSTREAM` na allowlist e precedência
- [ ] **Endpoint interno no Node** — o contrato está em §"Contrato com o Node"; a implementação é de outro PR
- [ ] **Job de CI** para este módulo — `tests.yml` tem `test-ws-gateway` e não tem `test-pagarme-webhook`; sem ele, o único portão é o `go build` da imagem
- [ ] **Exercitado com o Node no ar** — nada rodou contra o backend de verdade: o contrato foi testado contra um `httptest.Server`, não contra a implementação real
- [ ] **Deploy em qualquer ambiente** — nada subiu em staging nem em produção
- [ ] **`docs/20-pagarme-pendencias.md` atualizado** — fora do escopo deste PR por instrução

---

## O que ficou em aberto para o PR do Node

1. **Implementar os dois endpoints** de §"Contrato com o Node".
2. **Validar `charge.status` contra o vocabulário** antes do `applyCharge` — é a
   única coisa que o endpoint passa a aceitar de fora.
3. **Tolerar reaplicação** — já é o comportamento atual de `applyCharge` /
   `bridgePaidToOrder`, mas vale um teste que force o double-apply.
4. **Consertar o `isNull` da elegibilidade** (§"Bug do Node encontrado por este
   trabalho") — enquanto não for, o retry do Node continua morto.
5. **Teste de integração Go ↔ Node** com os dois de pé, de preferência contra um
   banco de teste.