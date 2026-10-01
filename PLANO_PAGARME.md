# Plano de Integração Multi-Tenant com Pagar.me

**Repo:** `/home/vinicius/pdv-completo`
**Worktree:** `/home/vinicius/pdv-worktrees/feat/pagarme-multitenant`
**Backend:** Node.js + TypeScript ESM + Fastify + Drizzle + PostgreSQL

---

## Contexto Atual (Single-Tenant → Multi-Tenant)

O sistema hoje é **single-tenant**:
- `store_settings` = singleton (`id: "singleton"`)
- `orders`, `order_payments`, `users`, `customers`, `restaurant_tables` — **sem `store_id`**
- `store_settings` guarda `pixKey`, `pixKeyType`, `enabledPaymentMethods` — tudo singleton

O objetivo: **cada restaurante (tenant) tem sua conta no Pagar.me, recebe o split na hora, e a plataforma fica com a taxa**.

---

## Fase 1 — Schema Multi-Tenant (Migração Pura)

**PR 1:** `0008_*` — schema multi-tenant

### Migration `0008_add_stores_and_store_id.sql`

```sql
-- Nova tabela stores
CREATE TABLE stores (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,           -- para subdomínio: joao.pdv.app
    owner_user_id TEXT REFERENCES "user"(id),
    status TEXT NOT NULL DEFAULT 'active', -- active, suspended, trial
    pagarme_recipient_id TEXT,            -- recipient_id do Pagar.me
    pagarme_status TEXT DEFAULT 'not_configured', -- not_configured, kyc_pending, active, rejected
    split_platform_percentage INTEGER DEFAULT 5, -- % que a plataforma fica
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para lookup por slug
CREATE INDEX idx_stores_slug ON stores(slug);

-- store_settings vira por-store (FK stores.id)
ALTER TABLE store_settings ADD COLUMN store_id TEXT REFERENCES stores(id);
UPDATE store_settings SET store_id = (SELECT id FROM stores LIMIT 1) WHERE store_id IS NULL;
-- NOTA: na migração real, precisa criar o store padrão antes
ALTER TABLE store_settings DROP CONSTRAINT store_settings_pkey;
ALTER TABLE store_settings ADD PRIMARY KEY (id, store_id);

-- Adiciona store_id nas tabelas principais
ALTER TABLE "order" ADD COLUMN store_id TEXT REFERENCES stores(id);
ALTER TABLE order_payment ADD COLUMN store_id TEXT REFERENCES stores(id);
ALTER TABLE "user" ADD COLUMN store_id TEXT REFERENCES stores(id);
ALTER TABLE customer ADD COLUMN store_id TEXT REFERENCES stores(id);
ALTER TABLE restaurant_table ADD COLUMN store_id TEXT REFERENCES stores(id);

-- Índices para queries por store
CREATE INDEX idx_order_store ON "order"(store_id);
CREATE INDEX idx_order_payment_store ON order_payment(store_id);
CREATE INDEX idx_user_store ON "user"(store_id);
CREATE INDEX idx_customer_store ON customer(store_id);
CREATE INDEX idx_restaurant_table_store ON restaurant_table(store_id);

-- Dados iniciais: store padrão (migração separada ou seed)
INSERT INTO stores (id, name, slug, status) VALUES ('00000000-0000-0000-0000-000000000001', 'Loja Padrão', 'default', 'active');
UPDATE store_settings SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE "order" SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE order_payment SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE "user" SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE customer SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE restaurant_table SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
```

**Rollback:** `DROP TABLE stores; ALTER TABLE ... DROP COLUMN store_id;`

### Novos arquivos (PR 1)
- `backend/src/infra/db/schema.ts` — adiciona tabela `stores` e `store_id` nas tabelas existentes
- `backend/src/infra/db/migrate-sqlite-to-pg.ts` — atualiza se necessário

### Arquivos existentes que mudam (PR 1)
- `backend/src/infra/db/schema.ts` — adiciona `stores` table e `store_id` columns
- `backend/src/application/store-settings.usecases.ts` — `getStoreSettingsUsecase` passa a receber `storeId`
- `backend/src/application/order/order.usecases.ts` — queries filtram por `store_id`

---

## Fase 2 — Tenant Resolution Middleware

**PR 2:** Middleware de resolução de tenant

### Novo arquivo: `backend/src/http/middleware/tenant.middleware.ts`

```typescript
import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../infra/db/client.js";
import { stores } from "../infra/db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "../domain/errors.js";

export async function resolveStoreMiddleware(req: FastifyRequest, reply: FastifyReply) {
  // 1. Tenta subdomínio: joao.pdv.app → slug "joao"
  const host = req.headers.host || "";
  const subdomain = host.split(".")[0];
  
  let storeId: string | null = null;
  
  if (subdomain && subdomain !== "www" && subdomain !== "api") {
    const store = await db.query.stores.findFirst({
      where: eq(stores.slug, subdomain)
    });
    if (store) storeId = store.id;
  }
  
  // 2. Fallback: header X-Store-ID (para API mobile/desktop)
  if (!storeId) {
    const headerStoreId = req.headers["x-store-id"] as string;
    if (headerStoreId) storeId = headerStoreId;
  }
  
  // 3. Fallback: usuário logado (se já autenticado)
  if (!storeId && (req as any).user?.storeId) {
    storeId = (req as any).user.storeId;
  }
  
  if (!storeId) {
    throw Errors.storeNotResolved();
  }
  
  // Valida se store existe e está ativa
  const store = await db.query.stores.findFirst({
    where: eq(stores.id, storeId)
  });
  
  if (!store || store.status !== "active") {
    throw Errors.storeInactive();
  }
  
  // Injeta no request
  (req as any).storeId = storeId;
  (req as any).store = store;
}
```

### Arquivos que mudam (PR 2)
- `backend/src/http/server.ts` — registra middleware antes das rotas
- `backend/src/domain/errors.ts` — adiciona `storeNotResolved`, `storeInactive`
- `backend/src/http/routes/*.ts` — rotas usam `(req as any).storeId`

---

## Fase 3 — Pagar.me Service + Onboarding

**PR 3:** Service wrapper + onboarding de tenant

### Novo arquivo: `backend/src/integrations/pagarme/pagarme.service.ts`

```typescript
import { PagarMeClient } from "@pagar.me/node-sdk";

let client: PagarMeClient | null = null;

export function getPagarMeClient(): PagarMeClient {
  if (!client) {
    client = new PagarMeClient(process.env.PAGARME_API_KEY!);
  }
  return client;
}

// Wrapper para não espalhar SDK pelo código
export const pagarme = {
  recipients: {
    create: (data: any) => getPagarMeClient().recipients.create(data),
    get: (id: string) => getPagarMeClient().recipients.get(id),
  },
  orders: {
    create: (data: any) => getPagarMeClient().orders.create(data),
    get: (id: string) => getPagarMeClient().orders.get(id),
  },
  webhooks: {
    validateSignature: (payload: string, signature: string) => {
      // HMAC SHA256 com PAGARME_WEBHOOK_SECRET
      const crypto = await import("node:crypto");
      const expected = crypto.createHmac("sha256", process.env.PAGARME_WEBHOOK_SECRET!)
        .update(payload).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    }
  }
};
```

### Novo arquivo: `backend/src/application/store/pagarme.usecases.ts`

```typescript
import { getPagarMeClient } from "../../integrations/pagarme/pagarme.service.js";
import { db } from "../../infra/db/client.js";
import { stores } from "../../infra/db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "../../domain/errors.js";

export async function onboardStorePagarmeUsecase(input: {
  storeId: string;
  legalName: string;
  document: string;      // CNPJ ou CPF
  email: string;
  bankAccount: {
    bank_code: string;
    agencia: string;
    conta: string;
    conta_dv: string;
    type: "checking" | "savings";
  };
}) {
  const store = await db.query.stores.findFirst({ where: eq(stores.id, input.storeId) });
  if (!store) throw Errors.notFound("Store");
  if (store.pagarmeRecipientId) throw Errors.alreadyConfigured("Pagar.me");

  const pm = getPagarMeClient();
  const recipient = await pm.recipients.create({
    type: input.document.length === 14 ? "company" : "individual",
    name: input.legalName,
    document: input.document,
    email: input.email,
    bank_account: input.bankAccount,
    automatic_anticipation: { enabled: true },
    metadata: { store_id: input.storeId }
  });

  await db.update(stores)
    .set({ pagarmeRecipientId: recipient.id, pagarmeStatus: "kyc_pending" })
    .where(eq(stores.id, input.storeId));

  return { recipientId: recipient.id, status: "kyc_pending" };
}

export async function getStorePagarmeStatusUsecase(storeId: string) {
  const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
  if (!store) throw Errors.notFound("Store");
  return { recipientId: store.pagarmeRecipientId, status: store.pagarmeStatus };
}

export async function resendKycLinkUsecase(storeId: string) {
  // Pagar.me não tem endpoint direto de reenvio; usa-se o link do dashboard
  // ou implementa-se fluxo customizado
  const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
  if (!store) throw Errors.notFound("Store");
  // TODO: integrar com endpoint de reenvio KYC se Pagar.me disponibilizar
  return { message: "Link de KYC deve ser acessado pelo dashboard do Pagar.me" };
}
```

### Novos endpoints (PR 3)
- `POST /admin/stores/:storeId/pagarme/onboard` — manager only
- `GET /admin/stores/:storeId/pagarme/status` — manager only
- `POST /admin/stores/:storeId/pagarme/kyc/resend` — manager only

---

## Fase 4 — Split no Pagamento + Webhook

**PR 4:** Core do pagamento com split + webhook

### Modifica `backend/src/application/order/order.usecases.ts`

```typescript
// No setOrderPaymentsUsecase / registerPaymentUsecase
// ANTES do upsertPaymentLines, criar order no Pagar.me

async function createPagarmeOrderWithSplit(tx: Tx, order: Order, store: Store, items: OrderItem[]) {
  if (!store.pagarmeRecipientId || store.pagarmeStatus !== "active") {
    throw Errors.paymentGatewayNotConfigured();
  }

  const pm = getPagarMeClient();
  
  const pagarmeOrder = await pm.orders.create({
    reference_id: order.id,              // seu order.id = idempotência
    customer: { name: "Cliente balcão", email: "balcao@local" },
    items: items.map(i => ({
      name: i.productName,
      unit_amount: Math.round(i.price * 100), // centavos
      quantity: i.qty
    })),
    payments: [{
      payment_method: { type: "pix" },   // ou "credit_card", "debit_card"
      split_rules: [{
        recipient_id: store.pagarmeRecipientId,
        percentage: store.splitPlatformPercentage || 95,
        liable: true,
        charge_processing_fee: true
      }, {
        recipient_id: process.env.PLATFORM_PAGARME_RECIPIENT_ID!,
        percentage: 100 - (store.splitPlatformPercentage || 95)
      }]
    }]
  });

  // Salva pagarme_order_id no order para idempotência/webhook
  await tx.update(orders)
    .set({ externalRef: pagarmeOrder.id })
    .where(eq(orders.id, order.id));

  // Retorna QR Code pro frontend
  const pixCharge = pagarmeOrder.charges.find(c => c.payment_method?.type === "pix");
  return {
    qrCode: pixCharge?.last_transaction?.qr_code,
    qrCodeBase64: pixCharge?.last_transaction?.qr_code_base64,
    txid: pixCharge?.last_transaction?.pix?.txid,
    pagarmeOrderId: pagarmeOrder.id
  };
}
```

### Novo arquivo: `backend/src/http/routes/pagarme-webhook.routes.ts`

```typescript
import { FastifyInstance } from "fastify";
import { pagarme } from "../../integrations/pagarme/pagarme.service.js";
import { db } from "../../infra/db/client.js";
import { orders, orderPayments } from "../../infra/db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "../../domain/errors.js";

export async function pagarmeWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/pagarme", async (req, reply) => {
    const signature = req.headers["x-hub-signature"] as string;
    const payload = JSON.stringify(req.body);
    
    if (!signature || !pagarme.webhooks.validateSignature(payload, signature)) {
      throw Errors.invalidSignature();
    }

    const event = req.body;
    
    // Idempotência: event.id + reference_id
    const idempotencyKey = `pagarme:${event.id}:${event.data?.reference_id}`;
    // Usar seu withIdempotency existente

    try {
      switch (event.type) {
        case "order.paid":
          await handleOrderPaid(event.data);
          break;
        case "charge.captured":
          await handleChargeCaptured(event.data);
          break;
        case "charge.refunded":
          await handleChargeRefunded(event.data);
          break;
        case "order.canceled":
          await handleOrderCanceled(event.data);
          break;
      }
      
      return { received: true };
    } catch (err) {
      req.log.error({ err, event: event.type }, "Pagar.me webhook error");
      throw err;
    }
  });
}

async function handleOrderPaid(data: any) {
  const orderId = data.reference_id;
  if (!orderId) return;

  await db.transaction(async (tx) => {
    // Confirma pagamentos locais baseado no split
    for (const charge of data.charges) {
      if (charge.last_transaction?.payment_method === "pix") {
        // Atualiza order_payment local como confirmed
        await tx.update(orderPayments)
          .set({
            confirmed: true,
            confirmedAt: new Date().toISOString(),
            confirmedBy: "pagarme_webhook"
          })
          .where(eq(orderPayments.orderId, orderId));
      }
    }

    // Atualiza order
    await tx.update(orders)
      .set({
        paymentConfirmedAt: new Date().toISOString(),
        paymentConfirmedBy: "pagarme_webhook",
        status: "closed"
      })
      .where(eq(orders.id, orderId));

    // Log de auditoria
    await logAction(tx, "system", "payment_confirmed_webhook", orderId, {
      pagarmeEventId: data.id,
      split: data.split_rules
    });
  });
}
```

### Arquivos que mudam (PR 4)
- `backend/src/application/order/order.usecases.ts` — integração com Pagar.me
- `backend/src/http/routes/order.routes.ts` — retorna QR do Pagar.me
- Novo: `backend/src/http/routes/pagarme-webhook.routes.ts`

---

## Fase 5 — Conciliação + Feature Flags

**PR 5:** Conciliação, relatórios, feature flags

### Conciliação no caixa

O `cashPaymentsBetween` continua somando `order_payments.confirmed`. A diferença: a confirmação vem do webhook, não do garçom.

```typescript
// backend/src/application/cash-flow/cash-flow.usecases.ts
// cashPaymentsBetween continua igual — filtra order_payment.confirmed = true
// O webhook já marcou confirmed = true
```

### Feature flags

```typescript
// backend/src/config/feature-flags.ts
export const features = {
  usePagarmePix: process.env.USE_PAGARME_PIX === "true",
  usePagarmeCard: process.env.USE_PAGARME_CARD === "true",
  pagarmeFallbackToLocal: process.env.PAGARME_FALLBACK_LOCAL === "true"
};
```

### Uso no código

```typescript
// No order.usecases.ts
if (features.usePagarmePix && input.method === "pix") {
  return createPagarmeOrderWithSplit(...);
}
// Fallback para Pix local (pix.js) se gateway cair
```

### Frontend breaking changes (documentados)

| Antes | Depois |
|-------|--------|
| `PUT /orders/:id/payments` retorna `{ payments }` | Retorna `{ payments, qrCode, qrCodeBase64, txid }` |
| Frontend usa `pix.js` local para gerar QR | Backend retorna QR do Pagar.me |
| Confirmação manual pelo garçom | Confirmação automática via webhook |

---

## Testes de Integração

### Mock do Pagar.me (para CI)

```typescript
// backend/test/mocks/pagarme.mock.ts
export const mockPagarMeClient = {
  recipients: {
    create: vi.fn().mockResolvedValue({ id: "re_mock", status: "active" }),
    get: vi.fn().mockResolvedValue({ id: "re_mock", status: "active" }),
  },
  orders: {
    create: vi.fn().mockResolvedValue({
      id: "or_mock",
      reference_id: "test-order-id",
      charges: [{
        payment_method: { type: "pix" },
        last_transaction: {
          qr_code: "000201...",
          qr_code_base64: "base64...",
          pix: { txid: "test-txid" }
        }
      }]
    }),
    get: vi.fn().mockResolvedValue({})
  },
  webhooks: {
    validateSignature: vi.fn().mockReturnValue(true)
  }
};
```

### Testes necessários

1. **Onboarding:** cria recipient, salva na store, status kyc_pending
2. **Pagamento Pix com split:** cria order no Pagar.me, retorna QR, salva externalRef
3. **Webhook order.paid:** confirma order_payment local, atualiza order, log auditoria
4. **Webhook charge.refunded:** cria sangria no caixa, cancela payment
5. **Idempotência:** mesmo event.id processado duas vezes não duplica
6. **Fallback:** se Pagar.me falha e feature flag ativa, usa Pix local

---

## Variáveis de Ambiente Necessárias

```env
PAGARME_API_KEY=sk_test_xxx
PAGARME_WEBHOOK_SECRET=whsec_xxx
PLATFORM_PAGARME_RECIPIENT_ID=re_platform_xxx
USE_PAGARME_PIX=true
USE_PAGARME_CARD=false
PAGARME_FALLBACK_LOCAL=true
```

---

## Ordem dos PRs e Dependências

| PR | Descrição | Depende de |
|----|-----------|------------|
| 1 | Schema multi-tenant (migração) | — |
| 2 | Tenant resolution middleware | PR 1 |
| 3 | Pagar.me service + onboarding | PR 1, PR 2 |
| 4 | Split no pagamento + webhook | PR 1, PR 2, PR 3 |
| 5 | Conciliação + feature flags | PR 4 |

Cada PR roda `npm run build && npm run test` no CI.

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Pagar.me API muda | Wrapper `pagarme.service.ts` isola mudanças |
| Webhook falha silenciosamente | Log estruturado + alerta no `alerts` room |
| KYC do lojista rejeitado | Status `rejected` bloqueia pagamentos; admin vê no painel |
| Gateway cai | Feature flag `PAGARME_FALLBACK_LOCAL` usa `pix.js` local |
| Split errado | Validação na criação: soma 100%, recipient_id válido |

---

## Próximos Passos Após Este Plano

1. **Aprovação do plano** → PR 1 (schema)
2. **Deploy em staging** com feature flag off
3. **Teste end-to-end** com conta sandbox Pagar.me
4. **Rollout gradual** por store (feature flag por store)
5. **Desligar Pix local** após validação em produção