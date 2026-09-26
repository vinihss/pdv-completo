import crypto from "node:crypto";

/**
 * Formato real confirmado contra a documentação atual da Meta (Cloud API):
 * entry[0].changes[0].value.messages[0].{from, text.body}. Conferir de novo
 * contra developers.facebook.com/docs/whatsapp/cloud-api/webhooks ao
 * integrar de verdade — a Meta já mudou esse formato no passado.
 */
export interface WhatsAppLocation {
  latitude: number;
  longitude: number;
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          type: string;
          text?: { body: string };
          location?: WhatsAppLocation;
        }>;
      };
    }>;
  }>;
}

export interface IncomingWhatsAppMessage {
  phone: string;
  text: string | null;
  location: WhatsAppLocation | null;
}

export function extractIncomingMessage(payload: WhatsAppWebhookPayload): IncomingWhatsAppMessage | null {
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return null;

  if (message.type === "location" && message.location) {
    return {
      phone: message.from,
      text: null,
      location: { latitude: message.location.latitude, longitude: message.location.longitude },
    };
  }

  if (message.type === "text" && message.text?.body) {
    return { phone: message.from, text: message.text.body, location: null };
  }

  return null;
}

/**
 * Verificação de assinatura do header X-Hub-Signature-256 (HMAC-SHA256 com o
 * app secret). Usa comparação em tempo constante — obrigatório pra esse tipo
 * de verificação, nunca comparar strings de assinatura com ===.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(received, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
