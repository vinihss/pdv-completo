import { and, desc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import {
  whatsappConnections,
  whatsappInboundMessages,
  whatsappOutboundMessages,
} from "../../infra/db/schema.js";
import { config } from "../../config/env.js";

/**
 * Estado da conexão WhatsApp (Embedded Signup) — o "onde está o token agora".
 *
 * Tudo async: o banco oficial é Postgres via node-postgres, então TODO
 * acesso é `await` (ver a nota em application/order/order.usecases.ts).
 *
 * Diferente do `ifood_state`, que é um KV de string, aqui o token tem
 * colunas de verdade: ele expira, muda de status e é consultável por
 * waba_id/phone_number_id — que é como o webhook sabe de qual conexão o
 * payload veio.
 *
 * Leitura usa `db` direto. Escrita que precisa compartilhar transação com
 * logAction/enqueueEvent vem em variante `*Tx(tx, …)`, seguindo a convenção
 * de stock.usecases.ts — quem abre a transação é o use case.
 */

export type ConnectionStatus = "active" | "expired" | "revoked" | "disconnected";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
export type MessageKind = "notification" | "bot_reply";

/** Coluna enum do Drizzle aceita exatamente estas unions (pgEnum em schema.ts). */

export interface Connection {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  businessName: string | null;
  displayPhoneNumber: string | null;
  displayName: string | null;
  accessToken: string;
  tokenExpiresAt: string | null;
  status: ConnectionStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** O que o notifier/webhook precisam para enviar: token + número da WABA. */
export interface ResolvedConnection {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  /** True quando veio do fallback de env (WHATSAPP_ACCESS_TOKEN legado). */
  legacy: boolean;
}

export async function getConnectionByWabaId(wabaId: string): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.wabaId, wabaId));
  return (row as Connection | undefined) ?? null;
}

/**
 * Mesma leitura, dentro de uma transação. `completeEmbeddedSignupUsecase`
 * precisa saber se a WABA JÁ estava conectada antes de gravar, e essa
 * pergunta tem de estar na mesma transação do insert — ler por fora daria
 * um retrato desatualizado.
 */
export async function getConnectionByWabaIdTx(tx: Tx, wabaId: string): Promise<Connection | null> {
  const [row] = await tx
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.wabaId, wabaId));
  return (row as Connection | undefined) ?? null;
}

/** A conexão ativa da instalação. `uq_whatsapp_single_active` garante no máximo uma. */
export async function getActiveConnection(): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.status, "active"))
    .limit(1);
  return (row as Connection | undefined) ?? null;
}

/**
 * Rota do webhook: a Meta manda o phone_number_id no payload, e é por ele
 * que se sabe qual WABA falou. Sem a linha correspondente não há token
 * para responder — o chamador só registra e devolve 200.
 */
export async function getConnectionByPhoneNumberId(phoneNumberId: string): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.phoneNumberId, phoneNumberId));
  return (row as Connection | undefined) ?? null;
}

/** Token expirado (quando a Meta mandou expires_in). NULL = sem expiração. */
export function isTokenExpired(conn: Pick<Connection, "tokenExpiresAt">): boolean {
  if (!conn.tokenExpiresAt) return false;
  const at = Date.parse(conn.tokenExpiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

export interface SaveConnectionInput {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  businessId?: string | null;
  businessName?: string | null;
  displayPhoneNumber?: string | null;
  displayName?: string | null;
  tokenExpiresAt?: string | null;
}

/**
 * Persiste a conexão do Embedded Signup. Reconectar a MESMA WABA atualiza a
 * linha; trocar de WABA desativa a anterior primeiro, porque o índice
 * parcial `uq_whatsapp_single_active` recusa duas linhas `active`.
 *
 * Mantém createdAt da linha original (é o "desde quando esta WABA está
 * conectada") e zera lastError — quem reconecta depois de um token caído
 * precisa ver a luz vermelha apagar.
 */
export async function saveConnectionTx(tx: Tx, input: SaveConnectionInput): Promise<Connection> {
  const now = new Date().toISOString();

  const [existing] = await tx
    .select({ id: whatsappConnections.id })
    .from(whatsappConnections)
    .where(eq(whatsappConnections.wabaId, input.wabaId))
    .limit(1);

  // Despromove qualquer outra ativa ANTES de promover esta: o índice
  // parcial é a barreira e ele olha a tabela no fim da instrução, então
  // a ordem importa.
  await tx
    .update(whatsappConnections)
    .set({ status: "disconnected" as ConnectionStatus, updatedAt: now })
    .where(
      and(
        eq(whatsappConnections.status, "active"),
        sql`${whatsappConnections.wabaId} <> ${input.wabaId}`,
      ),
    );

  const values = {
    phoneNumberId: input.phoneNumberId,
    accessToken: input.accessToken,
    businessId: input.businessId ?? null,
    businessName: input.businessName ?? null,
    displayPhoneNumber: input.displayPhoneNumber ?? null,
    displayName: input.displayName ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    status: "active" as ConnectionStatus,
    lastError: null,
    updatedAt: now,
  };

  if (existing) {
    const [updated] = await tx
      .update(whatsappConnections)
      .set(values)
      .where(eq(whatsappConnections.id, existing.id))
      .returning();
    return updated as Connection;
  }

  const [inserted] = await tx
    .insert(whatsappConnections)
    .values({ wabaId: input.wabaId, ...values })
    .returning();
  return inserted as Connection;
}

export async function setConnectionStatusTx(
  tx: Tx,
  wabaId: string,
  status: ConnectionStatus,
  lastError?: string | null
): Promise<void> {
  await tx
    .update(whatsappConnections)
    .set({ status, lastError: lastError ?? null, updatedAt: new Date().toISOString() })
    .where(eq(whatsappConnections.wabaId, wabaId));
}

/**
 * Marcar a conexão como caída, fora de transação. Usado pelo webhook: um
 * token expirado precisa virar `status = 'expired'` para o gerente VER o
 * problema na aba, e esse caminho é fire-and-forget (não tem onde abrir
 * transação com o log).
 */
export async function setConnectionStatus(
  wabaId: string,
  status: ConnectionStatus,
  lastError?: string | null
): Promise<void> {
  await db
    .update(whatsappConnections)
    .set({ status, lastError: lastError ?? null, updatedAt: new Date().toISOString() })
    .where(eq(whatsappConnections.wabaId, wabaId));
}

/**
 * Conexão a usar num envio.
 *
 * Ordem: WABA ativa no banco (caminho do Embedded Signup) e, só se não
 * houver nenhuma, o par legado de env — que serve para o dev local e para
 * instalações que ainda não migraram, com um warn para ficar visível que o
 * token está fora do fluxo oficial.
 */
export async function resolveConnection(): Promise<ResolvedConnection | null> {
  const active = await getActiveConnection();
  if (active) {
    return {
      wabaId: active.wabaId,
      phoneNumberId: active.phoneNumberId,
      accessToken: active.accessToken,
      tokenExpiresAt: active.tokenExpiresAt,
      legacy: false,
    };
  }

  if (config.whatsappAccessToken && config.whatsappPhoneNumberId) {
    console.warn(
      "[whatsapp] usando WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID do env (legado). " +
        "Conecte o WhatsApp pelo Embedded Signup para usar o token por WABA.",
    );
    return {
      wabaId: "",
      phoneNumberId: config.whatsappPhoneNumberId,
      accessToken: config.whatsappAccessToken,
      tokenExpiresAt: null,
      legacy: true,
    };
  }

  return null;
}

// ---------- mensagens enviadas (junta com o webhook de status) ----------

/**
 * Registra a mensagem que acabou de ser enviada. `wamid` é o id devolvido
 * pela Meta no POST /{phone_number_id}/messages — é o único jeito de casar
 * o `messages.statuses` que chega depois com o pedido do cliente.
 *
 * `onConflictDoNothing`: o mesmo wamid não deve ser contado duas vezes, e
 * uma reentrada aqui não é erro.
 */
export async function recordOutboundMessage(input: {
  wamid: string;
  wabaId: string;
  toPhone: string;
  kind: MessageKind;
  orderId?: string | null;
}): Promise<void> {
  await db
    .insert(whatsappOutboundMessages)
    .values({
      id: input.wamid,
      wabaId: input.wabaId,
      orderId: input.orderId ?? null,
      toPhone: input.toPhone,
      kind: input.kind,
      status: "sent" as MessageStatus,
    })
    .onConflictDoNothing();
}

export interface OutboundMessageRow {
  id: string;
  wabaId: string;
  orderId: string | null;
  toPhone: string;
  kind: MessageKind;
  status: MessageStatus;
  errorCode: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getOutboundMessage(wamid: string): Promise<OutboundMessageRow | null> {
  const [row] = await db
    .select()
    .from(whatsappOutboundMessages)
    .where(eq(whatsappOutboundMessages.id, wamid))
    .limit(1);
  return (row as OutboundMessageRow | undefined) ?? null;
}

export async function updateOutboundStatusTx(
  tx: Tx,
  wamid: string,
  status: MessageStatus,
  error?: { code?: number | null; message?: string | null } | null
): Promise<OutboundMessageRow | null> {
  const [row] = await tx
    .update(whatsappOutboundMessages)
    .set({
      status: status,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(whatsappOutboundMessages.id, wamid))
    .returning();
  return (row as OutboundMessageRow | undefined) ?? null;
}

export async function listOutboundMessages(limit = 50): Promise<OutboundMessageRow[]> {
  return (await db
    .select()
    .from(whatsappOutboundMessages)
    .orderBy(desc(whatsappOutboundMessages.createdAt))
    .limit(limit)) as OutboundMessageRow[];
}

// ---------- dedupe do inbound ----------

/**
 * Reserva o wamid de uma mensagem recebida. Devolve `true` se é nova.
 *
 * A Meta reenvia o MESMO webhook enquanto não receber 200, por até ~7 dias.
 * Sem esta barreira o bot trataria cada reenvio como uma fala nova do
 * cliente — o `insert` conflitando é o dedupe, então a corrida entre dois
 * deliveries simultâneos também não duplica o processamento.
 */
export async function claimInboundMessage(input: {
  wamid: string;
  wabaId: string;
  fromPhone: string;
  type: string;
}): Promise<boolean> {
  const rows = await db
    .insert(whatsappInboundMessages)
    .values({
      id: input.wamid,
      wabaId: input.wabaId,
      fromPhone: input.fromPhone,
      type: input.type,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappInboundMessages.id });
  return rows.length > 0;
}
