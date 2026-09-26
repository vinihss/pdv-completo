import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { whatsappConversations } from "../../infra/db/schema.js";
import { config } from "../../config/env.js";
import { getActiveSelfServiceOrderByPhoneUsecase } from "./order-intake.usecase.js";

const GREETING_TIMEOUT_MS = 60 * 60_000; // 1h — depois disso, cumprimenta nome de novo em vez de só lembrar

/**
 * Decisão: "checkout por fora" — o bot não conduz carrinho/checkout por
 * texto. Ele só cumprimenta e manda o link do cardápio externo (mesma
 * página compartilhada com o canal web), com o telefone já embutido pra a
 * página pular a etapa de identificação. Todo o resto (carrinho, endereço,
 * pagamento, confirmação) acontece na página — ver
 * 04-delivery-self-service-integration.md.
 *
 * O estado da conversa aqui existe só pra variar a mensagem entre "primeiro
 * contato" e "lembrete" — reaproveita os valores "welcome"/"done" do enum
 * já existente em whatsapp_conversation.state em vez de migrar o schema,
 * já que o significado de browsing/cart/checkout deixou de se aplicar.
 */
export async function handleIncomingWhatsAppMessage(phone: string, _rawText: string): Promise<{ replyText: string }> {
  const convo = await db.query.whatsappConversations.findFirst({ where: eq(whatsappConversations.phone, phone) });
  const recentlyGreeted = convo?.state === "done" && new Date(convo.updatedAt).getTime() > Date.now() - GREETING_TIMEOUT_MS;

  const now = new Date();
  const values = {
    state: "done" as const,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GREETING_TIMEOUT_MS).toISOString(),
  };
  if (convo) {
    await db.update(whatsappConversations).set(values).where(eq(whatsappConversations.phone, phone));
  } else {
    await db.insert(whatsappConversations).values({ phone, ...values });
  }

  // Cliente com pedido em aberto não quer cardápio — quer saber onde está.
  // O link vai direto pro acompanhamento (?order=<id>), que é a retomada
  // descrita em 04-delivery-self-service-integration.md. O stage também vem
  // na mensagem: se ele já saiu em rota, "cancelar" na página não adiantaria.
  const active = await getActiveSelfServiceOrderByPhoneUsecase(phone);
  if (active) {
    return {
      replyText:
        `Oi! Seu pedido está *${active.customerStage.label}*. ` +
        `Pra acompanhar ou cancelar, é só abrir o link abaixo:\n\n${buildMenuLink(phone, active.orderId)}\n\n` +
        `Qualquer coisa, é só mandar mensagem por aqui de novo.`,
    };
  }

  const link = buildMenuLink(phone);

  if (recentlyGreeted) {
    return { replyText: `Aqui está o link do cardápio de novo: ${link}` };
  }

  return {
    replyText:
      `Olá! 👋 Pra ver o cardápio, montar seu pedido e pagar, é só abrir o link abaixo — a entrega é combinada por lá também:\n\n${link}\n\n` +
      `Qualquer coisa, é só mandar mensagem por aqui de novo.`,
  };
}

function buildMenuLink(phone: string, orderId?: string): string {
  const url = new URL(config.externalMenuUrl);
  url.pathname = "/pedido"; // rota real do frontend (src/App.jsx) — ver CustomerMenuPage.jsx
  url.searchParams.set("via", "whatsapp");
  url.searchParams.set("phone", phone);
  if (orderId) url.searchParams.set("order", orderId); // abre direto no acompanhamento
  return url.toString();
}
