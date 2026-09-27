import crypto from "node:crypto";
import { whatsappConfig } from "./config.js";
import { resolveConnection, type ResolvedConnection } from "./state.js";
import { GraphApiError } from "./oauth.js";

/**
 * Envio de mensagem de texto pela Cloud API.
 *
 * Duas correções em relação à versão anterior deste arquivo:
 *
 *  1. A resposta da Graph é checada. O código antigo fazia
 *     `await fetch(...)` e jogava o `res` fora — um 401 (token expirado),
 *     um 403 (escopo faltando) ou um 131026 (número não registrado)
 *     retornavam 200 pro chamador e o PDV achava que tinha avisado o
 *     cliente. Agora vira erro.
 *  2. O token e o phone_number_id vêm da CONEXÃO (por WABA), e a versão
 *     do Graph é configurável, não v21.0 cravado no meio do path.
 *
 * Devolve o `wamid` que a Meta atribui à mensagem: é a chave que casa o
 * `messages.statuses` do webhook com o pedido do cliente.
 */

/** Por que não saiu:essaging indisponível. Logado e engolido de propósito. */
export class WhatsAppNotConnectedError extends Error {
  constructor() {
    super("WhatsApp não conectado.");
    this.name = "WhatsAppNotConnectedError";
  }
}

export interface SendResult {
  /** id da mensagem na Meta (wamid.XXXX...). Chave do webhook de status. */
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
}

function appSecretProof(accessToken: string): string | null {
  const secret = whatsappConfig.appSecret;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(accessToken, "utf8").digest("hex");
}

function buildHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const proof = appSecretProof(accessToken);
  if (proof) headers.appsecret_proof = proof;
  return headers;
}

/**
 * Envia um texto. Lança `WhatsAppNotConnectedError` se não houver conexão,
 * e `GraphApiError` se a Meta recusar.
 *
 * Sem conexão E sem token de env, cai no stub de log: o fluxo de
 * auto-atendimento/self-service é exercitado em teste e em dev sem
 * credenciais, e encher a fila de reenvio por causa disso não ajuda
 * ninguém. Com token de env OU conexão de verdade, a falha é erro.
 */
export async function sendTextMessage(to: string, body: string): Promise<SendResult | null> {
  const conn = await resolveConnection();
  if (!conn) {
    console.log(`[whatsapp.client stub] para ${to}:\n${body}`);
    return null;
  }
  return sendWith(conn, to, body);
}

export async function sendWith(
  conn: ResolvedConnection,
  to: string,
  body: string
): Promise<SendResult> {
  const res = await fetch(whatsappConfig.url(`/${conn.phoneNumberId}/messages`), {
    method: "POST",
    headers: buildHeaders(conn.accessToken),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const err = payload?.error;
    throw new GraphApiError(
      res.status,
      err?.message ?? `Envio recusado pela Cloud API (${res.status})`,
      err?.code,
      err?.error_subcode,
      err?.fbtrace_id
    );
  }

  const wamid: string | undefined = payload?.messages?.[0]?.id;
  if (!wamid) {
    // 200 sem id é resposta inesperada; sem o wamid o webhook de status
    // não teria como casar a mensagem, então melhor falhar alto.
    throw new GraphApiError(200, "A Cloud API aceitou o envio mas não devolveu o id da mensagem.");
  }

  return { wamid, phoneNumberId: conn.phoneNumberId, wabaId: conn.wabaId };
}
