import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { orders, customers } from "../../infra/db/schema.js";
import { sendTextMessage } from "./whatsapp.client.js";
import { recordOutboundMessage } from "./state.js";

/**
 * Gap real encontrado depois de implementado: o evento `delivery.*` já
 * enfileirado no outbox (delivery.usecases.ts) só alimenta o WebSocket
 * interno (painel do manager / página do cliente) — nada disparava mensagem
 * de verdade pro telefone do cliente, apesar do doc prometer isso.
 *
 * Decisão: notificar direto daqui (chamado pelas usecases de entrega,
 * fire-and-forget, mesmo padrão já usado em whatsapp-webhook.routes.ts),
 * não pelo outbox — o outbox_event.published é uma flag única compartilhada;
 * se o WS dispatcher e este notifier consumissem o mesmo evento, o primeiro
 * a marcar published=true faria o outro nunca ver o evento. Resolver isso
 * de verdade exigiria um outbox multi-consumidor, fora do escopo agora.
 * Envio real pro cliente independe do canal ter sido whatsapp ou web — todo
 * pedido self-service tem telefone do cliente, então todos recebem.
 */
async function customerPhone(orderId: string): Promise<string | null> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order?.customerId) return null;
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, order.customerId) });
  return customer?.phone ?? null;
}

async function notify(orderId: string, message: string) {
  const phone = await customerPhone(orderId);
  if (!phone) return; // pedido de balcão sem telefone, ou dado inconsistente — não é erro, só não há quem notificar
  const sent = await sendTextMessage(phone, message);

  // Guarda o wamid. É o que casa o `messages.statuses` que a Meta manda
  // depois com ESTE pedido — sem esta linha, a aba do gerente não tem como
  // mostrar "entregue" nem "falhou" para a mensagem do cliente.
  // `sent.wabaId` vazio = caminho legado (token de env), onde não há linha
  // em whatsapp_connection para a FK apontar.
  if (sent && sent.wabaId) {
    try {
      await recordOutboundMessage({
        wamid: sent.wamid,
        wabaId: sent.wabaId,
        toPhone: phone,
        kind: "notification",
        orderId,
      });
    } catch (err) {
      // A notificação JÁ saiu do WhatsApp; falhar aqui só faria a
      // usecase de entrega (que chama isto em fire-and-forget) logar um
      // erro que o gerente não pode corrigir. O envio é o que importa.
      console.error("[whatsapp] não consegui registrar a mensagem enviada:", err);
    }
  }
}

export async function notifyDispatched(orderId: string): Promise<void> {
  await notify(orderId, "Seu pedido saiu para entrega! 🛵 Chega em breve.");
}

export async function notifyDelivered(orderId: string): Promise<void> {
  await notify(orderId, "Seu pedido foi entregue! Bom apetite. 🎉");
}

export async function notifyFailed(orderId: string, reason: string): Promise<void> {
  await notify(orderId, `Tivemos um problema pra entregar seu pedido (${reason}). Vamos entrar em contato pra resolver.`);
}

// Disparado quando o ÚLTIMO item do pedido de delivery fica pronto
// (cozinha marcou tudo — order.usecases.ts#updateItemStatusUsecase).
export async function notifyReady(orderId: string): Promise<void> {
  await notify(orderId, "Seu pedido está pronto! 🍔 Saindo para entrega em breve.");
}

// Cancelamento (pelo cliente — cancel-order.usecase.ts; ou pelo manager
// via cancelOrderUsecase, quando a comanda tem telefone).
export async function notifyArriving(orderId: string): Promise<void> {
  await notify(orderId, "Sua entrega está chegando! 🍕 Está a poucos minutos.");
}

export async function notifyCancelled(orderId: string, reason: string): Promise<void> {
  await notify(orderId, `Seu pedido foi cancelado (${reason}). Se quiser, faça um novo pedido por aqui. 🙏`);
}
