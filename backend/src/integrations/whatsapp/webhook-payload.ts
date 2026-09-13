import crypto from "node:crypto";

/**
 * Formato real confirmado contra a documentação atual da Meta (Cloud API):
 * entry[0].changes[0].value.messages[0].{from, text.body}. Conferir de novo
 * contra developers.facebook.com/docs/whatsapp/cloud-api/webhooks ao
 * integrar de verdade — a Meta já mudou esse formato no passado.
 */
export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from: string; type: string; text?: { body: string } }>;
      };
    }>;
  }>;
}

export function extractIncomingMessage(payload: WhatsAppWebhookPayload): { phone: string; text: string } | null {
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== "text" || !message.text?.body) return null;
  return { phone: message.from, text: message.text.body };
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
