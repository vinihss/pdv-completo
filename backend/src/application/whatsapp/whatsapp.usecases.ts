import { db } from "../../infra/db/client.js";
import { AppError, Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { canStartEmbeddedSignup, whatsappConfig } from "../../integrations/whatsapp/config.js";
import {
  GraphApiError,
  debugToken,
  exchangeCodeForToken,
  getBusinessIdForWaba,
  getBusinessProfile,
  listPhoneNumbers,
  registerPhoneNumber,
  subscribeAppToWaba,
} from "../../integrations/whatsapp/oauth.js";
import {
  getActiveConnection,
  getConnectionByWabaIdTx,
  isTokenExpired,
  listOutboundMessages,
  saveConnectionTx,
  setConnectionStatusTx,
  updateOutboundStatusTx,
  type Connection,
  type MessageStatus,
  type OutboundMessageRow,
} from "../../integrations/whatsapp/state.js";
import type { IncomingStatusUpdate } from "../../integrations/whatsapp/webhook-payload.js";

/**
 * Use cases do Embedded Signup — conectar a WABA do cliente ao PDV.
 *
 * O fluxo, do ponto de vista do gerente, é um botão. O trabalho todo está
 * aqui: trocar o código, conferir o que o token realmente autoriza, ligar o
 * número na Cloud API e assinar os webhooks. Ver
 * docs/10-whatsapp-embedded-signup.md.
 */

/** Room de realtime da aba WhatsApp do gerente. */
export const WHATSAPP_ROOM = "whatsapp";

/** Status que a Meta reporta em `messages.statuses`. */
const STATUS_FROM_META: Record<string, MessageStatus> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
};

/**
 * Progresso do onboarding, devolvido ao front logo após a troca — a UI
 * usa para mostrar em que passo o Embedded Signup parou, porque cada
 * chamada pode falhar por um motivo diferente e o "algo deu errado" não
 * ajuda ninguém a resolver.
 */
export interface EmbeddedSignupResult {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  displayName: string | null;
  businessName: string | null;
  tokenExpiresAt: string | null;
  steps: {
    exchanged: boolean;
    scopesValidated: boolean;
    phoneResolved: boolean;
    registered: boolean;
    webhooksSubscribed: boolean;
  };
}

/**
 * Estado da integração para a UI do gerente.
 *
 * NUNCA devolve `accessToken`: é a credencial da WABA do cliente e não tem
 * motivo nenhum para sair do servidor.
 */
export async function getWhatsAppStatusUsecase(): Promise<{
  canConnect: boolean;
  missing: string[];
  connected: boolean;
  connection: {
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    displayName: string | null;
    businessId: string | null;
    businessName: string | null;
    status: string;
    tokenExpired: boolean;
    tokenExpiresAt: string | null;
    lastError: string | null;
    connectedAt: string;
  } | null;
}> {
  const missing: string[] = [];
  if (!whatsappConfig.appId) missing.push("META_APP_ID");
  if (!whatsappConfig.appSecret) missing.push("META_APP_SECRET");
  if (!whatsappConfig.signupConfigId) missing.push("WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID");

  const conn = await getActiveConnection();

  return {
    canConnect: missing.length === 0,
    missing,
    connected: Boolean(conn) && !isTokenExpired(conn!),
    connection: conn
      ? {
          wabaId: conn.wabaId,
          phoneNumberId: conn.phoneNumberId,
          displayPhoneNumber: conn.displayPhoneNumber,
          displayName: conn.displayName,
          businessId: conn.businessId,
          businessName: conn.businessName,
          status: conn.status,
          tokenExpired: isTokenExpired(conn),
          tokenExpiresAt: conn.tokenExpiresAt,
          lastError: conn.lastError,
          connectedAt: conn.createdAt,
        }
      : null,
  };
}

/** O que o browser precisa saber para chamar FB.login. Só valor público. */
export async function getWhatsAppSignupConfigUsecase(): Promise<{
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  canConnect: boolean;
}> {
  return {
    appId: whatsappConfig.appId ?? null,
    configId: whatsappConfig.signupConfigId ?? null,
    graphVersion: whatsappConfig.graphVersion,
    canConnect: canStartEmbeddedSignup(),
  };
}

export interface CompleteEmbeddedSignupInput {
  /** Code de autorização. Uso único, TTL de 30s. */
  code: string;
  /** Do postMessage WA_EMBEDDED_SIGNUP. Às vezes ausente/incompleto. */
  wabaId?: string | null;
  phoneNumberId?: string | null;
  businessId?: string | null;
  businessName?: string | null;
  userId: string;
}

/**
 * Fecha o Embedded Signup: troca o code, valida escopos, registra o número
 * e assina os webhooks.
 *
 * Ordem deliberada, e cada passo existe por um motivo:
 *
 *  1. **Troca o code.** Uso único e 30s de vida — se falhar, é terminal e
 *     o cliente tem que refazer o fluxo. Por isso o erro de validação é
 *     genérico e o motivo real vai para o log.
 *  2. **debug_token.** O `postMessage` do browser é pista, não prova: a
 *     Meta omite o `phone_number_id` em alguns caminhos. Os escopos e os
 *     `target_ids` vêm do token e são a fonte da verdade.
 *  3. **resolve o phone_number_id.** Do postMessage quando veio; senão
 *     busca em `/{waba}/phone_numbers`. Sem isso não dá para enviar nem
 *     rotear webhook.
 *  4. **register.** Habilita o número na Cloud API — sem ele o envio
 *     falha com 803.
 *  5. **subscribed_apps.** Assina NOSSO app nos webhooks da WABA, que é
 *     do cliente. Sem isso o envio funciona e a resposta do cliente nunca
 *     aparece — o bug mais confuso possível.
 */
export async function completeEmbeddedSignupUsecase(
  input: CompleteEmbeddedSignupInput
): Promise<EmbeddedSignupResult> {
  const missing: string[] = [];
  if (!whatsappConfig.appId) missing.push("META_APP_ID");
  if (!whatsappConfig.appSecret) missing.push("META_APP_SECRET");
  if (!whatsappConfig.signupConfigId) missing.push("WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID");
  if (missing.length > 0) throw Errors.whatsappNotConfigured(missing);

  // ---------- 1. code -> token ----------
  let token: string;
  let expiresInMs: number | null;
  try {
    const exchanged = await exchangeCodeForToken(input.code);
    token = exchanged.accessToken;
    expiresInMs = exchanged.expiresInMs;
  } catch (err) {
    const detail =
      err instanceof GraphApiError
        ? `Graph ${err.status}${err.code ? `/${err.code}` : ""}${err.subcode ? `/${err.subcode}` : ""}: ${err.message}`
        : String(err);
    console.error(`[whatsapp] troca do Embedded Signup falhou: ${detail}`);
    if (err instanceof GraphApiError) throw Errors.whatsappInvalidCode();
    throw err;
  }

  // A partir daqui toda chamada é da Meta e pode falhar por qualquer motivo
  // (token sem permissão, WABA inexistente, WABA já tem outro app, limite da
  // API). Deixar o GraphApiError vazarproduziria um 500 sem código de
  // domínio, e o gerente veria um "erro interno" sem nenhuma pista de que
  // o problema é com a Meta. O AppError que o próprio código threw (escopo
  // faltando, waba_id ausente) passa direto.
  const fromGraph = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      const detail =
        err instanceof GraphApiError
          ? `Graph ${err.status}${err.code ? `/${err.code}` : ""}: ${err.message}`
          : String(err);
      console.error(`[whatsapp] ${what} falhou: ${detail}`);
      throw Errors.whatsappProviderError(detail);
    }
  };

  // ---------- 2. escopos (fonte da verdade) ----------
  const debug = await fromGraph("debug_token", () => debugToken(token));
  if (!debug.hasManagement || !debug.hasMessaging) {
    const missingScopes: string[] = [];
    if (!debug.hasManagement) missingScopes.push("whatsapp_business_management");
    if (!debug.hasMessaging) missingScopes.push("whatsapp_business_messaging");
    throw Errors.whatsappMissingScopes(missingScopes);
  }

  // ---------- 3. qual WABA / qual número ----------
  // O postMessage manda a waba_id, mas o debug_token é quem confirma que o
  // token realmente a cobre. Preferimos o postMessage (é específico do
  // fluxo que o cliente acabou de fazer) e caímos no token quando ele
  // vier vazio.
  const wabaId = input.wabaId ?? debug.wabaIds[0] ?? null;
  if (!wabaId) {
    throw Errors.whatsappMissingScopes(["waba_id"]);
  }

  const numbers = await fromGraph("listagem de números", () => listPhoneNumbers(wabaId, token));
  const chosen =
    numbers.find((n) => n.id === input.phoneNumberId) ??
    (numbers.length === 1 ? numbers[0] : null) ??
    null;

  // Sem phone_number_id não há como enviar nem rotear webhook. Com mais de
  // um número e nenhum escolhido, o gerente tem que decidir qual — a UI
  // pede a escolha quando `numbers.length > 1`.
  if (!chosen) {
    throw Errors.whatsappMissingScopes(
      numbers.length > 1 ? ["phone_number_id (escolha qual número conectar)"] : ["phone_number_id"]
    );
  }

  // Perfil e business id são COSMÉTICOS: se a Meta recusar, a conexão
  // funciona igual e vale mais conectar do que travar por um campo que só
  // alimenta o cabeçalho da UI.
  const profile = await fromGraph("business_profile", () => getBusinessProfile(wabaId, token)).catch(
    () => null
  );
  const businessId =
    input.businessId ??
    (await fromGraph("leitura do portfolio", () => getBusinessIdForWaba(wabaId, token)).catch(
      () => null
    ));

  // ---------- 4. registra o número na Cloud API ----------
  await fromGraph("register do número", () => registerPhoneNumber(chosen.id, token));

  // ---------- 5. assina os webhooks da WABA ----------
  await fromGraph("assinatura dos webhooks", () => subscribeAppToWaba(wabaId, token));

  // ---------- persiste (com a auditoria na mesma transação) ----------
  const tokenExpiresAt = expiresInMs !== null ? new Date(Date.now() + expiresInMs).toISOString() : null;

  const conn = await db.transaction(async (tx) => {
    //ANTES de salvar: distinguir primeira conexão de reconexão. Ler depois
    // devolveria a linha já gravada e o log seria sempre "conectou".
    const previous = await getConnectionByWabaIdTx(tx, wabaId);

    const saved = await saveConnectionTx(tx, {
      wabaId,
      phoneNumberId: chosen.id,
      accessToken: token,
      businessId,
      businessName: input.businessName ?? null,
      displayPhoneNumber: chosen.displayPhoneNumber,
      // verified_name é o nome aprovado da Meta; `about` é a descrição
      // que o cliente preencheu no onboarding. Os dois, quando existem.
      displayName: chosen.verifiedName ?? profile?.about ?? null,
      tokenExpiresAt,
    });

    await logAction(
      tx,
      input.userId,
      previous ? "whatsapp_reconnected" : "whatsapp_connected",
      null,
      {
        wabaId,
        phoneNumberId: chosen.id,
        displayPhoneNumber: chosen.displayPhoneNumber,
        qualityRating: chosen.qualityRating,
        businessId,
        tokenExpiresAt,
      }
    );

    return saved;
  });

  return {
    wabaId: conn.wabaId,
    phoneNumberId: conn.phoneNumberId,
    displayPhoneNumber: conn.displayPhoneNumber,
    displayName: conn.displayName,
    businessName: conn.businessName,
    tokenExpiresAt: conn.tokenExpiresAt,
    steps: { exchanged: true, scopesValidated: true, phoneResolved: true, registered: true, webhooksSubscribed: true },
  };
}

/**
 * Desconecta. Apaga o token, o que é o ponto: enquanto `access_token`
 * estiver preenchido, qualquer chamada futura da Meta com ele é válida.
 */
export async function disconnectWhatsAppUsecase(userId: string): Promise<{ disconnected: boolean }> {
  const active = await getActiveConnection();
  if (!active) return { disconnected: false };

  await db.transaction(async (tx) => {
    await setConnectionStatusTx(tx, active.wabaId, "disconnected");
    await logAction(tx, userId, "whatsapp_disconnected", null, {
      wabaId: active.wabaId,
      displayPhoneNumber: active.displayPhoneNumber,
    });
  });

  return { disconnected: true };
}

/** Números da WABA, para a UI escolher quando a conta tem mais de um. */
export async function listWabaPhoneNumbersUsecase(wabaId: string, accessToken: string) {
  return listPhoneNumbers(wabaId, accessToken);
}

/**
 * Aplica os `messages.statuses` do webhook.
 *
 * É isto que dá sentido ao `whatsapp_outbound_message`: o status chega
 * pelo wamid, e sem a linha gravada no envio não há como dizer a qual
 * pedido (nem a qual cliente) a mensagem entregue pertence.
 *
 * Só status que a gente entende é aplicado — a Meta pode acrescentar
 * outros, e um status desconhecido não deve sobrescrever algo conhecido.
 * Cada update é a sua transação, com o log de auditoria junto.
 */
export async function applyStatusUpdateUsecase(
  updates: IncomingStatusUpdate[]
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const update of updates) {
    const status = STATUS_FROM_META[update.status];
    if (!status) {
      skipped += 1;
      continue;
    }

    const result = await db.transaction(async (tx) => {
      const updated = await updateOutboundStatusTx(tx, update.messageId, status, update.error);
      if (!updated) return null; // wamid desconhecido — mensagem de outra instalação, ou o envio nem foi nosso

      await logAction(
        tx,
        SYSTEM_USER_ID,
        "whatsapp_message_status",
        updated.orderId,
        {
          wamid: updated.id,
          to: updated.toPhone,
          kind: updated.kind,
          status,
          errorCode: update.error?.code ?? null,
          errorMessage: update.error?.message ?? null,
        }
      );

      // O gerente vê a mensagem mudar de estado na aba sem recarregar.
      await enqueueEvent(tx, WHATSAPP_ROOM, "whatsapp.message_status", {
        wamid: updated.id,
        orderId: updated.orderId,
        to: updated.toPhone,
        kind: updated.kind,
        status,
        errorCode: update.error?.code ?? null,
        errorMessage: update.error?.message ?? null,
        updatedAt: updated.updatedAt,
      });

      return updated;
    });

    if (result) applied += 1;
    else skipped += 1;
  }

  return { applied, skipped };
}

/** Histórico de mensagens enviadas, para a aba do gerente. */
export async function listRecentMessagesUsecase(limit = 50): Promise<OutboundMessageRow[]> {
  return listOutboundMessages(limit);
}

export type { Connection };
