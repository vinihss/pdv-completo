# 18 — iFood por loja (tenant) — análise e plano (sem implementação)

> **Data:** 2026-10-04 · **Decisão de produto:** cada tenant tem a sua própria loja no iFood
> (merchant ID e credenciais próprios). **Este documento registra o que foi encontrado no
> código e o que precisaria mudar. Nada foi implementado.**

## 1. Estado atual (`feat/main`, pós-§6.0)

| Camada | Onde | Hoje |
|---|---|---|
| Credenciais | `backend/src/config/env.ts:88-90` | globais em env (`IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_MERCHANT_ID` opcional) |
| Config | `integrations/ifood/config.ts` | `ifoodConfig` singleton, URLs de token/merchants/orders/catalog |
| Cliente HTTP + token cache | `integrations/ifood/client.ts` | OAuth client_credentials, token em `ifood_state` com TTL |
| Estado | `integrations/ifood/state.ts`, `schema.ts:545` | tabela `ifood_state` (key/value global, PK só `key`) — tokens, `merchantId`, `lastPollAt`, `lastCatalogSyncAt`, erros |
| Worker de polling | `integrations/ifood/worker.ts` | 1 instância no processo do backend (`server.ts:199`), advisory lock `LOCKS.ifoodWorker`, poll a cada 30s, ACK em batch |
| Pedido público | `worker.ts:81` → `order-handler.ts` | cria comanda com `created_by = 'system'`, itens, pagamentos iFood |
| Catálogo | `catalog-sync.ts` | push do cardápio local → iFood por SKU (`product.ifoodSku`) |
| Toggle por loja | `store_settings.ifood_enabled` (`schema.ts:152`) | por loja ✅ |
| Flag por produto | `product.ifood_enabled`, `product.ifoodSku` | por produto ✅ |
| Rotas de status | `http/routes/ifood.routes.ts` | `GET /ifood/status` expõe merchant/lastPoll/erros — sem filtro por loja |

**Consequência hoje:** se o mesmo PDV tentar atender 2 lojas que vendem no iFood,
`ifood_state` (tokens, merchantId, lastPoll) colidiria entre elas e o env global só
consegue autenticar 1 merchant.

## 2. Decisão

Cada tenant tem a sua própria app no iFood Developer Portal + merchant ID + credenciais.
Portanto o PDV precisa ser multi-merchant: credenciais por loja, estado por loja, worker
iterando lojas, rotas resolvendo a loja pelo contexto do request.

## 3. O que precisaria mudar (não implementado)

### Schema (nova migration `0002_*`, a partir do baseline `0001_init.sql`)

- `ifood_state`: PK passar de `(key)` para `(store_id, key)`; ou criar coluna `store_id`
  e migrar as chaves existentes para a loja default.
- Credenciais no DB: criar `stores.ifood_client_id`, `stores.ifood_client_secret`,
  `stores.ifood_merchant_id` (ou tabela `ifood_credential` 1:1 com a loja). Segredo em
  repouso — considerar criptografia/secret manager, não env do container.

### Código

- `config.ts`: deixa de exportar credenciais do env; `ifoodConfig` vira per-store
  (construída com as credenciais da loja).
- `client.ts`/`state.ts`: token cache e `merchantId` por loja (chave `(store_id, key)`).
- `worker.ts`: loop sobre as lojas com `ifood_enabled = true`; manter advisory lock por
  loja (`LOCKS.ifoodWorker:{store_id}`) para não colidir com o ciclo global.
- `order-handler.ts`: pedido criado na loja certa (hoje assume 1 merchant implícito).
- `catalog-sync.ts`: sync por loja.
- `routes/ifood.routes.ts`: `GET /ifood/status` resolve a loja pelo JWT (`t: <schema>`)
  e devolve só o estado daquela loja.
- Mock (`mock.ts`): continua global em dev, mas o worker precisa de um `merchantId`
  por ciclo — alinhar depois da migração de schema.

### Migração de dados (se houver cliente único hoje)

- Inserir a linha de credenciais da loja atual na nova coluna/tabela (valores do `.env`).
- Migrar as chaves de `ifood_state` para `(store_id, key)` da loja existente.
- Só então remover `IFOOD_CLIENT_ID/SECRET/MERCHANT_ID` do `.env` de produção.

## 4. Pré-requisitos

- Multi-tenant por schema (`docs/15`) em fases 0–1, porque "loja" hoje ainda é o banco
  todo; o `store_id` referenciaria `stores`.
- Definir se o worker roda dentro de cada container de tenant (mais simples, 1 processo
  por loja) ou num processo global iterando lojas (exige schema listado via catálogo
  de tenants).

## 5. Riscos / perguntas abertas

- Token da conta iFood é por *app*, não por merchant: se cada loja for um app separado,
  1 cliente HTTP por loja (ok); se for 1 app com N merchants, 1 token serve N lojas.
  Define o que precisa ser por loja: **merchant** sempre; **token**, depende do caso.
- Polling a cada 30s × N lojas: respeitar rate limit da API do iFood (agrupar ou fazer
  pull de orders por merchant, que é barato, mas o catálogo sync pode ser mais pesado).
- Segredo em DB: precisa de estratégia (vault, chave local no env, permissões por role).
