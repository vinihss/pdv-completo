import crypto from "node:crypto";

/**
 * Parser do webhook da Cloud API.
 *
 * A versão anterior deste arquivo lia só
 * `entry[0].changes[0].value.messages[0]`, e o payload declarado tipava
 * apenas `messages`. Duas coisas quebram com isso:
 *
 *  - A Meta BATCHA num único POST. Um mesmo request pode trazer vários
 *    `entry` e vários `changes` (uma WABA por entry; mais de uma mudança
 *    por WABA). Pegar só o primeiro descartava o resto em silêncio —
 *    sem erro, sem log, a mensagem simplesmente nunca existia.
 *  - Sem `metadata.phone_number_id` não há como saber DE QUEM é o
 *    payload. Com Embedded Signup o token é por WABA, então o id do
 *    número é o roteador. E sem `messages[].id` não há como dedupe: a
 *    Meta reenvia o mesmo webhook enquanto não receber 200, por ~7 dias.
 *
 * As funções de extração agora varrem o lote inteiro.
 */
export interface WhatsAppLocation {
  latitude: number;
  longitude: number;
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: WhatsAppWebhookValue;
    }>;
  }>;
}

export interface WhatsAppWebhookValue {
  /** id do número de negócio que recebeu a mensagem — o roteador por WABA. */
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: Array<{
    id?: string; // wamid — chave de dedupe
    from: string;
    type: string;
    text?: { body: string };
    location?: WhatsAppLocation;
  }>;
  statuses?: Array<{
    id: string; // wamid da mensagem enviada — casa com whatsapp_outbound_message
    status: string; // sent | delivered | read | failed
    timestamp?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; message?: string; error_data?: { details?: string } }>;
  }>;
}

export interface IncomingWhatsAppMessage {
  /** wamid; ausente só em payload muito antigo/malformado. */
  messageId: string | null;
  /**
   * id do número que recebeu — o roteador por WABA. NULL quando o payload
   * não traz metadata: o PARSER não descarta a mensagem por isso (é dado,
   * não roteamento); quem decide é a rota, que cai na conexão ativa quando
   * não há outra forma de escolher.
   */
  phoneNumberId: string | null;
  phone: string;
  text: string | null;
  location: WhatsAppLocation | null;
  type: string;
}

export interface IncomingStatusUpdate {
  messageId: string;
  phoneNumberId: string | null;
  status: string;
  recipientId: string | null;
  error: { code: number | null; message: string | null } | null;
}

/** Itera entry × changes, entregando o par (phone_number_id, value). */
function* eachValue(payload: WhatsAppWebhookPayload): Generator<WhatsAppWebhookValue> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.value) yield change.value;
    }
  }
}

/**
 * Todas as mensagens de entrada do lote, na ordem em que a Meta as mandou.
 *
 * Só `text` e `location` viram fala do bot. Qualquer outro tipo
 * (image, interactive, button, reaction, ...) é ignorado aqui — o que é
 * deliberado: o bot não sabe responder a isso, e devolver algo errado
 * seria pior que não responder. O `type` viaja junto para o chamador
 * registrar/auditar.
 */
export function extractAllIncomingMessages(
  payload: WhatsAppWebhookPayload
): IncomingWhatsAppMessage[] {
  const out: IncomingWhatsAppMessage[] = [];

  for (const value of eachValue(payload)) {
    const phoneNumberId = value.metadata?.phone_number_id ?? null;

    for (const message of value.messages ?? []) {
      const base = {
        messageId: message.id ?? null,
        phoneNumberId,
        phone: message.from,
        type: message.type,
      };

      if (message.type === "location" && message.location) {
        out.push({
          ...base,
          text: null,
          location: { latitude: message.location.latitude, longitude: message.location.longitude },
        });
        continue;
      }

      if (message.type === "text" && message.text?.body) {
        out.push({ ...base, text: message.text.body, location: null });
        continue;
      }
    }
  }

  return out;
}

/**
 * Todos os updates de status do lote. Um `sent` pode chegar no mesmo
 * request que a mensagem de texto; os statuses são independentes das
 * `messages` e vivem em `value.statuses`.
 */
export function extractAllStatusUpdates(payload: WhatsAppWebhookPayload): IncomingStatusUpdate[] {
  const out: IncomingStatusUpdate[] = [];

  for (const value of eachValue(payload)) {
    for (const status of value.statuses ?? []) {
      if (!status?.id) continue;
      const first = status.errors?.[0];
      out.push({
        messageId: status.id,
        phoneNumberId: value.metadata?.phone_number_id ?? null,
        status: status.status,
        recipientId: status.recipient_id ?? null,
        error: first ? { code: first.code ?? null, message: first.message ?? null } : null,
      });
    }
  }

  return out;
}

/**
 * Wrapper de compatibilidade: a PRIMEIRA mensagem do lote, no formato
 * antigo (sem ids). O chamador novo usa extractAllIncomingMessages.
 */
export function extractIncomingMessage(payload: WhatsAppWebhookPayload): IncomingWhatsAppMessage | null {
  return extractAllIncomingMessages(payload)[0] ?? null;
}

/**
 * Verificação de assinatura do header X-Hub-Signature-256 (HMAC-SHA256 com o
 * app secret). Usa comparação em tempo constante — obrigatório pra esse tipo
 * de verificação, nunca comparar strings de assinatura com ===.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(received, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
