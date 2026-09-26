import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { whatsappConversations } from "../../infra/db/schema.js";
import { config } from "../../config/env.js";
import { getActiveSelfServiceOrderByPhoneUsecase } from "./order-intake.usecase.js";
import { calcularEntregaUsecase } from "../delivery/calcular-entrega.usecase.js";
import type { WhatsAppLocation } from "../../integrations/whatsapp/webhook-payload.js";

const GREETING_TIMEOUT_MS = 60 * 60_000;

type ConversationState = "awaiting_location" | "awaiting_confirmation" | "awaiting_correction" | "done";

interface ConversationRow {
  phone: string;
  state: string;
  deliveryAddress: string | null;
  updatedAt: string;
  expiresAt: string;
}

async function getConversation(phone: string): Promise<ConversationRow | null> {
  const convo = await db.query.whatsappConversations.findFirst({ where: eq(whatsappConversations.phone, phone) });
  return convo ?? null;
}

async function updateConversation(phone: string, state: ConversationState, deliveryAddress?: string) {
  const now = new Date();
  const values = {
    state,
    deliveryAddress: deliveryAddress ?? null,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GREETING_TIMEOUT_MS).toISOString(),
  };
  await db
    .insert(whatsappConversations)
    .values({ phone, ...values })
    .onConflictDoUpdate({ target: whatsappConversations.phone, set: values });
}

async function handleLocationMessage(phone: string, location: WhatsAppLocation): Promise<string> {
  try {
    const result = await calcularEntregaUsecase({
      latitude: location.latitude,
      longitude: location.longitude,
    });

    if (!result.disponivel) {
      return (
        `📍 Encontrei este endereço:\n\n${result.endereco.formattedAddress}\n\n` +
        `❌ Infelizmente não atendemos essa região (${result.entrega.distanciaKm}km).\n` +
        `Você pode tentar outro endereço ou pedir delivery por telefone.`
      );
    }

    const addressText = [
      result.endereco.street && result.endereco.number
        ? `${result.endereco.street}, ${result.endereco.number}`
        : result.endereco.street,
      result.endereco.neighborhood,
      result.endereco.city,
      result.endereco.state,
      result.endereco.postalCode ? `CEP ${result.endereco.postalCode}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await updateConversation(phone, "awaiting_confirmation", result.endereco.formattedAddress);

    return (
      `📍 Encontrei este endereço:\n\n${addressText}\n\n` +
      `🚚 Distância: ${result.entrega.distanciaKm}km\n` +
      `⏱️ Tempo estimado: ${result.entrega.tempoMinutos}min\n` +
      `💰 Taxa de entrega: R$ ${result.entrega.frete.toFixed(2)}\n\n` +
      `Esse endereço está correto?\n\n` +
      `✅ Digite "sim" para confirmar\n` +
      `✏️ Digite "não" para corrigir`
    );
  } catch (err) {
    return "Não foi possível calcular a entrega para essa localização. Tente novamente ou digite seu endereço manualmente.";
  }
}

async function handleConfirmation(phone: string): Promise<string> {
  const convo = await getConversation(phone);
  if (!convo || convo.state !== "awaiting_confirmation") {
    return "Não há nenhuma confirmação pendente. Compartilhe sua localização para calcular a entrega.";
  }

  await updateConversation(phone, "done");
  return (
    "Perfeito! Agora é só montar seu pedido no cardápio:\n\n" +
    `${buildMenuLink(phone)}\n\n` +
    "A entrega será calculada automaticamente com base no seu endereço."
  );
}

async function handleCorrection(phone: string, text: string): Promise<string> {
  await updateConversation(phone, "awaiting_location");
  return `Sem problemas! Tente compartilhar sua localização novamente ou digite seu endereço completo (rua, número, bairro, cidade):`;
}

export async function handleIncomingWhatsAppMessage(
  phone: string,
  text: string | null,
  location: WhatsAppLocation | null
): Promise<{ replyText: string }> {
  const convo = await getConversation(phone);
  const state = (convo?.state ?? "done") as ConversationState;

  if (location) {
    const reply = await handleLocationMessage(phone, location);
    return { replyText: reply };
  }

  if (text) {
    const normalized = text.trim().toLowerCase();

    if (state === "awaiting_confirmation") {
      if (normalized === "sim" || normalized === "s" || normalized === "confirmar" || normalized === "ok") {
        const reply = await handleConfirmation(phone);
        return { replyText: reply };
      }
      if (normalized === "não" || normalized === "n" || normalized === "corrigir" || normalized === "errado") {
        const reply = await handleCorrection(phone, text);
        return { replyText: reply };
      }
    }

    if (state === "awaiting_location" || state === "awaiting_correction") {
      if (normalized.length > 10) {
        return { replyText: "Obrigado! Para calcular a entrega, preciso que você compartilhe sua localização pelo WhatsApp (botão de anexo → Localização)." };
      }
    }
  }

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
  const recentlyGreeted = convo?.state === "done" && new Date(convo.updatedAt).getTime() > Date.now() - GREETING_TIMEOUT_MS;

  if (recentlyGreeted) {
    return { replyText: `Aqui está o link do cardápio de novo: ${link}` };
  }

  await updateConversation(phone, "done");

  return {
    replyText:
      `Olá! 👋 Pra ver o cardápio, montar seu pedido e pagar, é só abrir o link abaixo — a entrega é combinada por lá também:\n\n${link}\n\n` +
      `Qualquer coisa, é só mandar mensagem por aqui de novo.`,
  };
}

function buildMenuLink(phone: string, orderId?: string): string {
  const url = new URL(config.externalMenuUrl);
  url.pathname = "/pedido";
  url.searchParams.set("via", "whatsapp");
  url.searchParams.set("phone", phone);
  if (orderId) url.searchParams.set("order", orderId);
  return url.toString();
}
