# Guia de Testes

Como rodar e adicionar testes no projeto.

> As contagens de testes variam entre branches e com o tempo. Use os comandos e a saída atual como evidência; não use contagens copiadas em outros documentos como critério de aprovação.

## Backend

```bash
cd backend
npm run test
```

**Framework**: vitest 5 + PostgreSQL dedicado `pdv_test` (recriado no global setup via `TEST_DATABASE_URL`).

### O banco de teste NÃO está no repo

`pdv_test` é um Postgres **ad-hoc**: precisa ser subido à mão antes da suíte.
Sem ele, os testes não falham por asserção — falham com `relation
"store_settings" does not exist`, porque o global setup faz `DROP SCHEMA
public` e não encontra migration nenhuma para reaplicar. É um sintoma que
parece bug de código e não é.

```bash
docker run -d --name pdv-test-db -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=pdv -e POSTGRES_PASSWORD=pdv_test_pw -e POSTGRES_DB=pdv_test \
  postgres:16

cd backend && npm run db:migrate   # aplica migrations/*.sql; o global setup
                                  # também aplica, mas exige o schema legível
```

A porta **55432** e as credenciais estão fixas em `test/test-db.ts:15`. A URL
precisa de `?sslmode=disable` quando você apontar para outro banco — sem isso
o `lib/pq` (usado pelos serviços Go) assume `require` e a conexão falha.

Este banco **não pode ser compartilhado** com um servidor de dev: as suítes
publicam de verdade e disputam o advisory lock `pdv:payment:worker` e o
`pdv:outbox:owner`, os mesmos que o backend usa em produção.

### Cobertura por arquivo (a lista pode não refletir todos os testes da branch)

| Arquivo | Cobertura |
|---|---|
| `test/alerts.test.ts` | Central de alertas (25 testes): rollback, desempate de seq, público, rooms |
| `test/cash-flow.test.ts` | Fluxo de caixa: sessão única, sangria/suprimento/fechamento, idempotência, hard block, estorno, resumo |
| `test/catalog.test.ts` | Catálogo: CRUD produtos, categorias, ordenação, busca |
| `test/delivery-location.test.ts` | Geocoding, cache, cálculo de distância |
| `test/delivery-pricing.test.ts` | Cálculo de preço de entrega |
| `test/idempotency.test.ts` | Retry de failed/expirado, 409 processing, cache de completed |
| `test/maintenance.test.ts` | Outbox corrompido não derruba, cleanup |
| `test/outbox-dispatcher.test.ts` | Ciclo do dispatcher: publica, teto de 50, ordem `created_at`/`seq`, payload corrompido, dono único por advisory lock |
| `test/order-flow.test.ts` | Validação de mesa, eventos outbox de fechamento/cancelamento/pagamento/delete |
| `test/pagarme.test.ts` | Camada Pagar.me V5 (20 testes): transições de status, `refundableAmount`, mapper (case-insensitive, unitário vs total, cartão por `card_token`), assinatura do webhook, criação idempotente, falha do gateway, ponte `order.paid` → `order_payment`, 401 de assinatura, evento ignorado, estorno 422/parcial, reconciliação |
| `test/payment-lines.test.ts` | Linha de pagamento `confirmed` não some em reenvio do `PUT` (preserva/recusa/reescreve não confirmada) + regressão do P0 do caixa, no `PUT` e no legado |
| `test/pix-key.test.ts` | Canonicalização de chave Pix (6 testes) |
| `test/printer.test.ts` | Impressão: 404 vs 503, auto-print, resetState |
| `test/profiles.test.ts` | Perfis caixa/entregador: filtro de login, acesso por papel, fluxo completo |
| `test/purchase.test.ts` | Compras + custo médio móvel (7 testes) |
| `test/self-service.test.ts` | Página pública: carrinho, variações, grupos obrigatórios |
| `test/stock.test.ts` | Ledger de estoque (10 testes): débito, refund, bloqueio, margem |
| `test/team-customers.test.ts` | Clientes + equipe (28 testes): CRUD, CPF/observações, foto do cliente, comanda aberta, histórico paginado, série do gráfico, PIN |
| `test/tenant-routing.test.ts` | Multi-tenant Fase 1 (29 testes): resolução por subdomínio/domínio próprio/apex/`localhost`, rótulos reservados (`www`/`app`/`api`), **slug inválido → 404 e nunca o default**, kill-switch `TENANT_ROUTING`, `PLATFORM_ROOT_DOMAIN`, `tenant_inactive` (403), validação de `schema_name` em código, contrato do `GET /public/tenants/resolve` (inclusive o que **não** sai), `migrations/registry/` fora do glob do runner de tenant, DDL do registry nascendo em `public` mesmo com `search_path` de tenant, e o cache do registry (TTL, invalidação, resultado negativo) |
| `test/uploads.test.ts` | Storage por tenant (14 testes): serving de `/uploads/:kind/:filename`, logo com `no-cache`, ETag/304, só basename no banco, arquivo só no kind dele, remoção, isolamento entre tenants, traversal barrado, e o `migrate-uploads-layout` (idempotente, `--dry-run`, `--revert`) |
| `test/whatsapp.test.ts` | WhatsApp: webhooks, dedupe, status (35 testes) |

### Padrões

- **Postgres dedicado**: o global setup recria o banco `pdv_test` antes de cada suíte
- **`resetState()`**: algumas suítes (printer) precisam resetar o estado entre testes (mesa compartilhada)
- **Stub HTTP**: printer usa stub na porta 3456; whatsapp usa stub da Graph em porta fixa apontada pelo `env` do `vitest.config.ts`

### Isolamento do banco de teste

O `pdv_test` é **exclusivo da suíte**. Servidor de dev nunca pode apontar para ele — `npm run dev` usa outro banco (o de dev). A causa de 99% dos testes "instáveis" no outbox é essa mistura.

**Sintoma**: `test/outbox-dispatcher.test.ts` falha com contagens erradas — `expected 25 to be 50` no teste do teto de 50 por ciclo, ou `pollOutboxOnce()` devolvendo `0` no teste do advisory lock. E **quais** testes falham muda entre execuções. Essa instabilidade com "contagem errada" (e não com timeout ou conexão recusada) é a assinatura do problema.

**Por quê**: `startOutboxDispatcher()` roda a cada 200ms em qualquer servidor de pé (`src/http/server.ts:197`). Com um servidor alheio conectado no mesmo banco, ele disputa as linhas do outbox (publica as mais antigas por `created_at` antes do teste) e o advisory lock de transação com a suíte. Não é bug de código — é configuração de ambiente.

**Guard**: `test/global-setup.ts` checa `pg_stat_activity` antes do `recreateSchema` e falha cedo com mensagem acionável (lista `pid`, `application_name`, `state`, `client_addr` e diz o que parar). Bônus: com conexão estrangeira viva, o `DROP SCHEMA public CASCADE` do próprio setup também pode travar ou falhar de forma confusa — o guard falha antes, legível.

Escape para quem legitimamente precisa (depurar o banco na mão enquanto a suíte roda, duas execuções concorrentes em worktrees diferentes):

```bash
TEST_ALLOW_FOREIGN_CONNECTIONS=1 npm run test
```

Como achar o processo estranho:

```bash
ss -tnp | grep 55432                                       # quem está conectado
ps -eo pid,ppid,etimes,args | grep "dist/http/server.js"   # servidor órfão tem PPID 1
```

## Frontend

```bash
cd frontend
npm run test
```

**Framework**: vitest + jsdom + Testing Library.

### Cobertura por arquivo (a lista pode não refletir todos os testes da branch)

| Cobertura | Arquivos |
|---|---|
| Casca do app + menu | `App.test.jsx`, `AppMenu.test.jsx` |
| Drawer/accordion | `Drawer.test.jsx`, `AccordionMenu.test.jsx` |
| Modal/header/variação | `Modal.test.jsx`, `ScreenHeader.test.jsx`, `VariationModal.test.jsx` |
| Login por PIN | `Login.test.jsx` (teclado físico, input do celular, Enter/botão, sem auto-envio) |
| Detalhe da comanda | `OrderDetail.test.jsx` |
| Modais de compra/equipe | `ProductModal.test.jsx`, `UserModal.test.jsx` |
| Caixa/reports | `CashierApp.test.jsx`, `ReportsTab.test.jsx` |
| Página pública | `CustomerMenuPage.test.jsx` (integração: pega ReferenceError de import perdido) |
| Sino de alertas | `AlertBell.test.jsx` (17 testes, fluxo completo com WS dublê) |
| Áudio | `shared/lib/audio.test.js` (9 testes) |
| useRealtime | `shared/hooks/useRealtime.test.jsx` (3 testes) |
| Config e boot desktop | `SettingsTab.test.jsx`, `BootGate.test.jsx` |
| Lógica pura | `reports/cashReportView.js`, `features/customer-menu/cartLogic.js` |
| Fronteiras FSD | `__tests__/fsd-boundaries.test.js` (35 casos) |

### Padrões

- **Mock de entity**: usar o padrão-preservar (`vi.mock` + `importOriginal`)
- **Mock declarativo da barrel esconde o resto da entity** (UI e model) e quebra o render
- **Teste de integração da página** (`CustomerMenuPage.test.jsx`) é o que pega ReferenceError de import perdido — `tsc`/build não pegam

## Gateway WebSocket (Go)

```bash
cd ws-gateway
gofmt -l .        # tem que sair vazio
go vet ./...
go test -count=1 ./...
```

**Cobertura** (5 arquivos, 51 funções de teste, 122 casos com subtestes): nada de servidor de
pé — os testes de socket sobem um `httptest.Server` real — e **banco só em cinco deles**, que
dependem de `WS_GATEWAY_TEST_DATABASE_URL` (ver abaixo).

| Arquivo | Cobertura |
|---|---|
| `internal/auth/auth_test.go` | JWT: token válido, segredo/assinatura/`alg: none`/HS384/HS512/RS256 (confusão de algoritmo), expirado sem tolerância de relógio, extração pelo subprotocol, token recusado na query string |
| `internal/roommanager/roommanager_test.go` | Matriz de `canJoinRoom` (positivos E negativos, por papel), rooms iniciais por perfil, todo room inicial passa por `CanJoin`, regex do `order:<uuid>` do WS público |
| `internal/connmanager/connmanager_test.go` | Broadcast por room e por usuário, duas abas do mesmo usuário, `join` idempotente, `Remove`/`Close` idempotentes, fila cheia não trava o broadcast, ids de conexão únicos |
| `internal/outbox/outbox_test.go` | Envelope: `emittedAt` no formato do Node (ms com 3 dígitos), `payload: null` quando vazio. **Gate** `WS_DISPATCH`: default-deny (só `1`/`true`/`yes`/`on`), `Run` com gate desligado não toca no banco e explica por quê, `Run` com gate ligado só volta ao cancelar, `PollOnce` com gate desligado não abre transação. **Ciclo** (precisa de Postgres): publica para assinante, marca publicado mesmo sem assinante, payload corrompido, pula quando outro dispatcher tem o lock, e **com o gate desligado a linha plantada continua `published = false`** |
| `cmd/gateway/main_test.go` | `/health`: 200 com banco bom e `outboxEnabled` verdadeiro, 503 rápido com banco recusando, **503 dentro do orçamento com o banco travado** (pinger que ignora o prazo do contexto, como o lib/pq contra um Postgres congelado), martelado sem vazar goroutine nem esgotar o pool, recuperação sozinha quando o banco volta, 200 sem `DATABASE_URL`, e a matriz de `outboxEnabled` = pool E gate (6 casos, incluindo `sim` = desligado). Shutdown: `fechaPool` fecha o pool uma única vez, é imediato sem pool e não pendura com `Close` preso |

**Os cinco testes que precisam de Postgres** (`WS_GATEWAY_TEST_DATABASE_URL`) são os de
`PollOnce`; o helper `testDB` faz `t.Skip` em dois casos — env ausente, ou o banco não respondeu
— e nenhuma outra parte do módulo tem `t.Skip`. Rodando local sem a env, são **cinco SKIP** e o
resto verde, e `go test` **sai 0**: é o modo de falha silencioso. Por isso o job
`test-ws-gateway` sobe um Postgres e, logo depois do `go test`, **falha o job se algum teste
pulou** — é esse passo, e não o banco, que garante que a proteção do gate rodou:

```yaml
# .github/workflows/tests.yml, job test-ws-gateway
services:
  postgres:
    image: postgres:16              # porta 55432, mesmas credenciais do job test-backend
env:
  WS_GATEWAY_TEST_DATABASE_URL: postgres://pdv:pdv_test_pw@localhost:55432/pdv_test?sslmode=disable
# depois do `go test -v | tee $RUNNER_TEMP/ws-gateway-test.log`:
if grep -nE -B2 '^[[:space:]]*--- SKIP: ' "$log"; then exit 1; fi
```

O `?sslmode=disable` não é decoração: o driver do gateway é o lib/pq, que assume
`sslmode=require` quando a DSN não diz nada, e a imagem `postgres:16` do serviço não tem TLS —
sem o parâmetro os cinco testes pulam com "SSL is not enabled on the server" e o job fica
**verde sem executar nada**. Para rodar a suíte completa localmente, aponte a env para um Postgres
qualquer: o `testDB` cria a tabela `outbox_event` com `IF NOT EXISTS` e não faz `TRUNCATE`
(cada teste só fala das linhas que plantou).

```bash
WS_GATEWAY_TEST_DATABASE_URL='postgres://pdv:pdv_test_pw@localhost:55432/pdv_test?sslmode=disable' \
  go test -count=1 ./...
```

**O que a suíte ainda NÃO cobre**: métricas (o `/health` expõe `connections`/`users`, mas não há
série temporal nem alerta), e o comportamento sob carga real de WS — o máximo de socket testado é
o de um `httptest.Server` local.

## Serviço Pagar.me (Go)

```bash
cd pagarme-webhook
gofmt -l .        # tem que sair vazio
go vet ./...
go test -count=1 ./...
```

**Cobertura** (7 arquivos, 131 funções de teste, 228 casos com subtestes): nada de serviço de pé — o
`nodeapi` e o `gateway` batem em `httptest.Server` reais — e **banco só em duas suítes**, que
dependem de `PAGARME_TEST_DATABASE_URL` (ver abaixo).

| Arquivo | Cobertura |
|---|---|
| `internal/signature/signature_test.go` | HMAC-SHA1 do cabeçalho do Pagar.me: assinatura válida, tolerância de caixa e de prefixo, e as formas de recusa (`base64` no lugar de hex, caractere não-hex, prefixo no meio, corpo truncado, truncada ao meio), corpo com acentos, bytes arbitrários sem panic, e o segredo sendo mesmo a chave da HMAC |
| `internal/charge/charge_test.go` | `MapStatus` e os aliases (`canceled`/`cancelled`, caixa e espaço), status desconhecido **não** virando palpite; `order_to_charge` (pago, guarda o id do payload pelo prefixo do topo, resolução de status, amount); `round2` que não perde centavo por `float`; amount como string, objeto e array; varredura de `extractPix`; `event_id`; omissão de campo ausente em vez de zero |
| `internal/nodeapi/nodeapi_test.go` | Cliente do endpoint interno do Node: POST no caminho do evento e no da cobrança, token no header, corpo do contrato, omissão de campo não enviado, base URL com barra final; **tabela de classificação de erro** (404 ignorado, 4xx retryable, timeout retryable, `applied:false` não é erro, 2xx sem corpo é aplicado, 2xx com corpo inválido é retryable), e a garantia de que o cliente **não** retenta sozinho (a espera é do drain, holding transação) |
| `internal/gateway/gateway_test.go` | `Find` no Pagar.me: GET no path do pedido, Basic com senha vazia, 404 devolvendo `nil` sem erro, rede e timeout, sem credencial ou sem id, corpo sem id, corpo inválido retryable, base URL com barra final, o mesmo mapper do webhook, e cancelamento de contexto abortando a chamada |
| `internal/inbox/inbox_test.go` | `Record` gravando em `payment_event` **de verdade** (precisa de Postgres): evento novo, **dedupe no reenvio** e dedupe por par de provider (o `ON CONFLICT` do índice UNIQUE), recusa de evento sem id, `payment_id` nulo, `created_at` no formato do banco, `unknown` quando o type vem ausente. Sem banco: `nowISO` (formato, UTC, layout que não se desloca), `newUUID` v4 e sem repetição, e `truncarError` |
| `internal/queue/queue_test.go` | Gate do drain (default-deny, e o par `Run` desligado não toca no banco / ligado só volta ao cancelar), backoff e seu teto, `cargaDe`, `textArray` (inclusive válido no Postgres). **Ciclo** (precisa de Postgres): `DrainOnce` processa evento novo, **nunca seleciona `processing`**, ignora terminais, respeita backoff não vencido e pega `failed` com backoff vencido, não pega DLQ, ordena por `seq`, lote de 25, **falha de um não para o lote**, **pula quando outro drenador tem o lock**, a tabela de destino de cada erro, payload inválido vai para a DLQ e **estoura o teto e para na DLQ**, e passa com o lock da reconciliação; `ReconcileOnce` relê pendente e aplica no Node, ignora terminais e cobrança sem order id, gateway desconhecido não é erro, falha de uma não para as outras, `no_transition` não é erro, usa lock diferente do drain e respeita o limite; e `CountDeadLettered` |
| `internal/server/server_test.go` | HTTP do webhook: 503 sem `PAGARME_SECRET_KEY` (recusando **antes** de parsear), 401 de assinatura inválida vencendo body inválido, 400 de corpo que não é JSON / não é objeto / não é UTF-8 / sem `event_id`, 503 de falha de infraestrutura, 200 + corpo cru no evento novo, **200 `duplicate` no reenvio**, 413 acima do teto (e o limite de bytes aceito logo abaixo), recusa de método ≠ POST, e as rotas. **Saúde**: 200 com credencial e banco, 503 sem pool, 503 com inbox ausente sem panic, 503 com banco travado, 503 quando o banco recusa e quando congela, volta a 200 ao destravar, reflete o gate do drain, e o `HealthProbe` isolado (teto de perguntas presas, destrava depois, ok velho deixa de valer, cancelamento no shutdown não conta como falha) |

**Os 38 testes que precisam de Postgres** (`PAGARME_TEST_DATABASE_URL`) são os de `Record` na
`inbox` (7) e os de `DrainOnce`/`ReconcileOnce`/`CountDeadLettered` na `queue` (31). O helper
`testDB` — replicado nos dois pacotes — faz `t.Skip` em dois casos, **env ausente ou o banco não
respondeu**, e nenhuma outra parte do módulo tem `t.Skip`.

> **A suíte fica VERDE sem banco.** Rodando local sem a env, são **38 SKIP**, 190 passam e
> `go test` **sai 0**. É falso-verde garantido: o que some nesse verde é a proteção contra **dedupe
> quebrado** na inbox (o mesmo evento do Pagar.me aplicado duas vezes) e a única forma de
> **observar a DLQ** do drain. Nenhum dos dois é substituível por mock — o `ON CONFLICT` sobre índice
> UNIQUE e o `pg_try_advisory_xact_lock` só existem no banco de verdade. Antes de acreditar num
> verde, confira o número de SKIP (`go test -v | grep -c 'SKIP'`).

Por isso o job `test-pagarme-webhook` sobe um Postgres e, logo depois do `go test`, **falha o job se
algum teste pulou** — é esse passo, e não o banco, que garante que as duas proteções rodaram:

```yaml
# .github/workflows/tests.yml, job test-pagarme-webhook
services:
  postgres:
    image: postgres:16              # porta 55432, mesmas credenciais do job test-backend
env:
  PAGARME_TEST_DATABASE_URL: postgres://pdv:pdv_test_pw@localhost:55432/pdv_test?sslmode=disable
# depois do `go test -v | tee $RUNNER_TEMP/pagarme-webhook-test.log`:
if grep -nE -B2 '^[[:space:]]*--- SKIP: ' "$log"; then exit 1; fi
```

O `?sslmode=disable` não é decoração: o driver do serviço é o mesmo `lib/pq` do gateway, que assume
`sslmode=require` quando a DSN não diz nada, e a imagem `postgres:16` do serviço não tem TLS — sem
o parâmetro os **38** testes pulam com "pq: SSL is not enabled on the server" e o job fica **verde
sem executar nada**. Pior ainda que a env ausente, porque aqui a env *está* setada e o banco *está*
de pé: só o driver desiste.

Para rodar a suíte completa localmente, aponte a env para um Postgres **dedicado**. O `testDB` de
cada pacote cria um **schema novo por execução** (nome aleatório), aponta o `search_path` do pool
para ele, cria as tabelas ali com `IF NOT EXISTS` e derruba o schema no `t.Cleanup` — não faz
`TRUNCATE` e não vê linha de fora. Por isso os dois pacotes podem rodar em paralelo no mesmo banco;
o que não pode é o **worker do Node** apontando para o mesmo banco, porque o `DrainOnce` disputa o
advisory lock `pdv:payment:worker`.

```bash
PAGARME_TEST_DATABASE_URL='postgres://pdv:pdv_test_pw@localhost:55432/pdv_test?sslmode=disable' \
  go test -count=1 -race ./...
```

O `-race` está no job porque este serviço tem estado compartilhado em três lugares — o `HealthProbe`
(`st`/`inFlight` sob `sync.Mutex`, lido do handler enquanto o probe roda em goroutine), o `fakeAplica`
(acumulador com `mu`, lido da goroutine do teste depois de `go d.Run(ctx)`) e o `fechaPool`
(goroutine + `select` com prazo). Sem `-race` um mutex que pare de cobrir um campo não reprova nada:
os testes continuam verdes e a corrida fica esperando um CI mais lento para se manifestar.

**O que a suíte ainda NÃO cobre**: o `printer` e o `ws-gateway` (o `Find` bate em `httptest.Server`,
não no Pagar.me real) e o contrato do `ApplyEvent`/`ApplyCharge` contra um backend Node de verdade —
o `nodeapi` prova o que o cliente envia e como classifica a resposta, mas o acordo entre os dois
lados ainda é conferido por smoke.

## Printer (daemon Go)

```bash
cd printer/daemon
go test ./...
```

**Cobertura**: caminhos, config padrão, CORS, templates embutidos, health.

## Como adicionar novos testes

### Backend

1. Criar arquivo `test/<dominio>.test.ts`
2. Usar o global setup (banco `pdv_test` já é recriado)
3. Se precisar de estado limpo entre testes, usar `resetState()`
4. Para stub de HTTP, usar porta fixa (padrão: 3456 para printer, porta configurável para whatsapp)

### Frontend

1. Criar arquivo `src/**/__tests__/<Component>.test.jsx` ou `test/<dominio>.test.js`
2. Usar Testing Library (`render`, `screen`, `fireEvent`, `waitFor`)
3. Para mock de entity, usar `vi.mock` + `importOriginal`
4. Para testar lógica pura, criar arquivo `.test.js` sem DOM

### Gateway WebSocket

1. Criar arquivo `ws-gateway/internal/<pacote>/*_test.go`, no mesmo pacote do código (precisa
   de acesso a campos privados, como o `connmanager_test.go` faz). Handler do servidor (rotas,
   `/health`) vai em `ws-gateway/cmd/gateway/main_test.go`
2. Usar `testing` padrão do Go; tabela de casos com `t.Run` para a matriz de rooms
3. Para testar o hub sem mock, dialar um `httptest.Server` que registra no `Manager` real
4. Precisa de banco: usar o helper `testDB` do `internal/outbox` (o padrão é `WS_GATEWAY_TEST_DATABASE_URL`),
   que garante a tabela e faz `t.Skip` se não houver Postgres. **Um `t.Skip` novo derruba o CI**
   (passo "nenhum teste pulado") — então banco obrigatório em teste novo é decisão consciente,
   não acidente
5. Para testar prazo, encolher o tempo no teste em vez de dormir: o `healthProbe` carrega
   `poll`, `timeout`, `staleAfter` e `maxInFlight` como campos (o construtor copia as constantes),
   e o `cmd/gateway/main_test.go` mostra o padrão
6. Rodar `gofmt -l .` antes de commitar — o CI falha o job se sair algo

### Printer

1. Criar arquivo `printer/daemon/*_test.go`
2. Usar `testing` padrão do Go
3. Para stub de TCP, usar `net.Listen` em porta aleatória

### Serviço Pagar.me

1. Criar arquivo `pagarme-webhook/internal/<pacote>/*_test.go`, no mesmo pacote do código (precisa
   de acesso a campos privados, como o `fakeAplica` faz). Handler HTTP vai no
   `internal/server/server_test.go`
2. Usar `testing` padrão do Go; tabela de casos com `t.Run` para matrizes (o destino de cada erro do
   Node, os aliases de status, as formas de recusa de assinatura)
3. Para o cliente do Node e o `Find` do Pagar.me, subir `httptest.Server` real e registrar o
   mapper/fake — o que está em jogo é o que vai no cabo e como a resposta é classificada
4. Precisa de banco: usar o helper `testDB` do **mesmo pacote** (`internal/inbox` e `internal/queue`
   têm o seu; a env é `PAGARME_TEST_DATABASE_URL`), que cria um schema novo por execução, garante
   as tabelas e faz `t.Skip` se não houver Postgres. **Um `t.Skip` novo derruba o CI** (passo
   "nenhum teste pulado") — então banco obrigatório em teste novo é decisão consciente, não
   acidente
5. Para mexer no gate do drain (`PAGARME_DRAIN`), usar `t.Setenv`; para o caso "a variável **não
   existe**", usar o helper `semGate(t)` do próprio pacote, que só sabe descer a `os.Unsetenv`
   dentro de `t.Cleanup`
6. Para testar prazo, encolher o tempo no teste em vez de dormir: o `HealthProbe` carrega `poll`,
   `timeout`, `staleAfter` e `maxInFlight` como campos (o construtor copia as constantes), e o
   `pingerPreso` mostra o padrão de simular um banco congelado
7. Rodar `gofmt -l .` antes de commitar — o CI falha o job se sair algo

## Critérios de verificação

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros
2. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo alterado tiver suíte
3. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros
4. Gateway WS: `cd ws-gateway && gofmt -l . && go vet ./... && go test -count=1 ./...` — com
   `WS_GATEWAY_TEST_DATABASE_URL` apontando para um Postgres, se o que mudou toca o ciclo do
   outbox (sem ela, cinco testes pulam em silêncio e o comando sai 0)
5. Serviço Pagar.me: `cd pagarme-webhook && gofmt -l . && go vet ./... && go test -count=1 ./...` —
   com `PAGARME_TEST_DATABASE_URL` apontando para um Postgres **dedicado** sempre que o que mudou
   toca a inbox ou o drain. Sem ela a suíte **sai 0** com 38 SKIP: confira `go test -v | grep -c SKIP`
   antes de acreditar no verde
6. Smoke manual por perfil: login → abrir comanda → lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar
7. Conferir o critério de aceite correspondente em `docs/03-acceptance-criteria.md`
8. Toda mudança realtime: garantir que o evento chega a um room que o client realmente assina
9. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`

Os passos 4 e 5 são o que os jobs `test-ws-gateway` e `test-pagarme-webhook` do
`.github/workflows/tests.yml` rodam — o reusable workflow, não o chamador. Os jobs vão além deles
em duas coisas: sobem um Postgres para a suíte que precisa de banco e **falham o job se algum teste
poulou** (é o que transforma "verde com cinco SKIP" em vermelho, no caso do gateway, e "verde com
38 SKIP" em vermelho, no caso do serviço Pagar.me). Mudança em qualquer um dos dois sem esse passo
passa o gate de merge e só quebra no `go build` da imagem em produção.
