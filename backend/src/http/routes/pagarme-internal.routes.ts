/**
 * Canal interno entre o backend Node e o serviço Go `pagarme-webhook/`.
 *
 * ## A regra que organiza os dois lados
 *
 * O Go NUNCA escreve estado de domínio. Quando o drain dele precisa que um
 * evento vire mudança de `payment.status`, ele PERGUNTA aqui e o Node faz a
 * transação — `applyCharge`, `bridgePaidToOrder`, `audit_log` e `outbox_event`
 * continuam onde já estavam. Ver `applyInternalChargeUsecase`.
 *
 * Os status desta rota NÃO são livres: são a tabela que o drainer Go lê para
 * decidir entre reenviar com backoff, marcar `ignored` ou jogar na DLQ
 * (`pagarme-webhook/internal/queue/queue.go:tratarErro`):
 *
 *   200               a transação rodou (inclusive o no-op idempotente)
 *   200 applied:false uma guarda recusou — normal na reconciliação, NÃO é erro
 *   401/403           token — DLQ imediata no Go
 *   404               não é cobrança nossa — o Go marca `ignored` (terminal)
 *   422               conteúdo inválido — DLQ imediata no Go
 *   429/5xx           infraestrutura — retry com backoff
 *
 * Por isso o `charge.status` inválido é 422 e NÃO 401: responder 401 por um
 * problema de payload botaria o evento na DLQ com a pista errada no log do Go.
 *
 * ## Não é alcançável pela internet
 *
 * Não há rota `/internal/*` no Caddyfile: o que não casa com nenhum `handle`
 * específico cai no frontend. O Go fala com este backend pela rede interna
 * (`NODE_INTERNAL_URL`, default `http://backend:3000`), então ele não depende
 * do Caddy — e o Caddy tem um `handle /internal/*` que responde 404, para o
 * caminho não ser servido pelo PWA nem por um catch-all futuro.
 */
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../../config/env.js";
import { Errors } from "../../domain/errors.js";
import { PAYMENT_STATUSES, type GatewayCharge } from "../../domain/payment.js";
import { applyInternalChargeUsecase, type InternalChargeSource } from "../../application/payment/payment.usecases.js";

/**
 * Header canônico do token. `Authorization: Bearer` é aceito como alias (ver
 * `tokenDoRequest`), mas o canônico é este: `Bearer` é o esquema do JWT do
 * login, e um token opaco de serviço no mesmo formato faz o log de acesso do
 * proxy mostrar duas coisas que parecem idênticas e significam coisas
 * diferentes.
 */
const HEADER_CANONICO = "x-internal-token";

/**
 * O token do servidor, com furo de teste.
 *
 * `config` é um snapshot feito no load do módulo (por isso o `vitest.config.ts`
 * ter que resolver a env antes de qualquer import), então sem esta ponte não
 * haveria como testar o caso "PAGARME_INTERNAL_TOKEN não configurada". O mesmo
 * padrão de `setPaymentGatewayForTests`.
 *
 * `undefined` = usar o `config` (produção). `null` = token ausente, para o
 * teste. `string` = token forçado.
 */
let tokenOverride: string | null | undefined;
export function setInternalTokenForTests(token: string | null | undefined): void {
  tokenOverride = token;
}
function tokenDoServidor(): string | null {
  if (tokenOverride !== undefined) return tokenOverride;
  const t = config.pagarmeInternalToken;
  return t ? t : null;
}

/**
 * Extrai o token do request. Aceita o header canônico e, como alias,
 * `Authorization: Bearer <token>`.
 */
function tokenDoRequest(headers: Record<string, unknown>): string | null {
  const bruto = headers[HEADER_CANONICO];
  if (typeof bruto === "string" && bruto.length > 0) return bruto;

  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** Comparação em tempo constante. */
function tokenIgual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // `timingSafeEqual` exige mesmo tamanho e lança se não tiver. A comparação de
  // tamanho vaza o TAMANHO do token (não o conteúdo) — que é o trade-off
  // padrão deste padrão e infinitamente melhor que `===`.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * `charge.status` é validado contra o vocabulário do domínio — é a fronteira
 * onde dado externo entra, e um status cru chegando ao `applyCharge` entraria
 * na tabela de transições como `undefined`.
 *
 * `paidAmount`/`refundedAmount` são `.optional()` e NÃO Required, e isso é
 * load-bearing: o Go os envia como ponteiro com `omitempty`, e o `applyCharge`
 * distingue ausente de zero (`if (charge.paidAmount != null && …)`). Aceitar
 * só `number`Required transformaria "ausente" em erro, e tipar como
 * `.default(0)` transformaria "ausente" em zero — as duas mudam comportamento.
 */
const chargeSchema = z.object({
  providerOrderId: z.string().min(1),
  providerChargeId: z.string().min(1).optional(),
  providerPaymentId: z.string().min(1).optional(),
  status: z.enum(PAYMENT_STATUSES),
  amount: z.number(),
  paidAmount: z.number().optional(),
  refundedAmount: z.number().optional(),
  pix: z
    .object({
      qrCode: z.string().optional(),
      qrCodeBase64: z.string().optional(),
      qrCodeUrl: z.string().optional(),
      txid: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .optional(),
  cardLast4: z.string().optional(),
  cardBrand: z.string().optional(),
});

const requestSchema = z.object({
  eventId: z.string().optional(),
  eventType: z.string().optional(),
  providerOrderId: z.string().optional(),
  providerPaymentId: z.string().optional(),
  source: z.enum(["event", "reconciliation"]),
  charge: chargeSchema,
});

/**
 * Guarda de serviço. Recusa sem distinguir token ausente de token errado: a
 * resposta é a mesma, e o log do servidor também não diz qual foi.
 *
 * Sem token configurado no servidor a resposta é a mesma 401 de propósito — o
 * que muda é o LOG, que nomeia a env. Um servidor sem token que respondesse
 * "aceito" seria o pior dos dois mundos: o Go acharia que aplicou efeito e o
 * pagamento nunca entraria.
 */
function guardaToken(headers: Record<string, unknown>, log: { error: (...a: unknown[]) => void }): void {
  const esperado = tokenDoServidor();
  if (!esperado) {
    log.error(
      "[pagarme] PAGARME_INTERNAL_TOKEN não configurada — o canal interno está RECUSANDO todo chamado. " +
        "O serviço `pagarme-webhook/` grava a inbox mas não consegue aplicar efeito: " +
        "gere o token (`openssl rand -hex 32`) e ponha o MESMO valor nos dois serviços.",
    );
    throw Errors.invalidInternalToken();
  }

  const recebido = tokenDoRequest(headers);
  if (!recebido || !tokenIgual(recebido, esperado)) throw Errors.invalidInternalToken();
}

function validar(body: unknown): z.infer<typeof requestSchema> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // 422 pelo catálogo, e NÃO o `ZodError` global (que é 400): o Go trata 422
    // como DLQ immediate com log de "payload inválido", e 400 cairia no
    // genérico de 4xx. O detalhe vai junto porque é o que aponta o campo.
    const primeiro = parsed.error.issues[0];
    const caminho = primeiro?.path?.join(".") ?? "(corpo)";
    throw Errors.invalidInternalCharge(
      primeiro ? `${caminho}: ${primeiro.message}` : "corpo inválido",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function pagarmeInternalRoutes(app: FastifyInstance) {
  // `preHandler` do plugin = escopo deste plugin só. `orderRoutes` faz o mesmo
  // com `authMiddleware`, e é por isso que o webhook público e estas rotas não
  // se misturam.
  app.addHook("preHandler", async (req) => {
    guardaToken(req.headers as Record<string, unknown>, app.log);
  });

  /**
   * Caminho de EVENTO. O `eventRowId` é o `payment_event.id` local (UUID), e
   * não o `event_id` do gateway: o gateway reenvia o MESMO `event_id`, e usar
   * ele na URL tornaria a segunda entrega um reenvio (dedupe) no lugar de uma
   * reaplicação idempotente.
   */
  app.post("/internal/pagarme/events/:eventRowId/apply", async (req) => {
    const { eventRowId } = req.params as { eventRowId: string };
    const body = validar(req.body);
    const result = await applyInternalChargeUsecase({
      source: body.source as InternalChargeSource,
      charge: body.charge as GatewayCharge,
      eventRowId,
      eventType: body.eventType,
    });
    return { applied: result.applied, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
  });

  /**
   * Caminho de RECONCILIAÇÃO: mesmo handler, sem evento. A reconciliação relê o
   * gateway por conta própria e não tem `payment_event` para ligar.
   */
  app.post("/internal/pagarme/charges/apply", async (req) => {
    const body = validar(req.body);
    const result = await applyInternalChargeUsecase({
      source: body.source as InternalChargeSource,
      charge: body.charge as GatewayCharge,
      eventType: body.eventType,
    });
    return { applied: result.applied, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
  });
}