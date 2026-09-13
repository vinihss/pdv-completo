import { config } from "../../config/env.js";

/**
 * Stub deliberado: não há conta real da Meta configurada neste ambiente de
 * desenvolvimento. Loga o que seria enviado em vez de chamar a Graph API de
 * verdade. Trocar o corpo de sendTextMessage por uma chamada real a
 * `https://graph.facebook.com/v21.0/{phoneNumberId}/messages` quando houver
 * WHATSAPP_ACCESS_TOKEN de produção — a assinatura da função não muda.
 */
export async function sendTextMessage(to: string, body: string): Promise<void> {
  if (!config.whatsappAccessToken || !config.whatsappPhoneNumberId) {
    console.log(`[whatsapp.client stub] para ${to}:\n${body}`);
    return;
  }

  await fetch(`https://graph.facebook.com/v21.0/${config.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
}
