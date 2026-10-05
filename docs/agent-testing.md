# Guia de Testes

Como rodar e adicionar testes no projeto.

## Backend

```bash
cd backend
npm run test
```

**Framework**: vitest 5 + PostgreSQL dedicado `pdv_test` (recriado no global setup via `TEST_DATABASE_URL`).

### Suítes (20 arquivos)

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

### Suítes (44 arquivos)

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

## Critérios de verificação

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros
2. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo alterado tiver suíte
3. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros
4. Gateway WS: `cd ws-gateway && gofmt -l . && go vet ./... && go test -count=1 ./...` — com
   `WS_GATEWAY_TEST_DATABASE_URL` apontando para um Postgres, se o que mudou toca o ciclo do
   outbox (sem ela, cinco testes pulam em silêncio e o comando sai 0)
5. Smoke manual por perfil: login → abrir comanda → lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar
6. Conferir o critério de aceite correspondente em `docs/03-acceptance-criteria.md`
7. Toda mudança realtime: garantir que o evento chega a um room que o client realmente assina
8. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`

O passo 4 é o mesmo que o job `test-ws-gateway` do `.github/workflows/tests.yml` roda — o
reusable workflow, não o chamador. O job vai além dele em duas coisas: sobe um Postgres para a
suíte de `PollOnce` e falha o job se algum teste pulou (é o que transforma "verde com cinco
SKIP" em vermelho). Mudança no gateway sem esse passo passa o gate de merge e só quebra no
`go build` da imagem em produção.
