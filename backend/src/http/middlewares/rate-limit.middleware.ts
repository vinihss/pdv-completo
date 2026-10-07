import type { FastifyRequest, FastifyReply } from "fastify";
import { Errors } from "../../domain/errors.js";

// Rate limit simples em memória — suficiente para instância única (modo
// local, único processo). Em modo cloud com múltiplas réplicas, isso
// precisaria virar um store compartilhado (Redis); fora de escopo da etapa 1.
let hits = new Map<string, number[]>();
export const resetRateLimit = () => { hits.clear() }

/**
 * Fábrica genérica de rate limit por chave (IP, telefone, etc.), reaproveitada
 * pelas rotas públicas de self-service (§05 "Convenções" — "rate limiting por
 * IP/telefone (a definir na implementação)"). `keyFn` retorna `null` pra
 * pular a checagem quando a chave não está disponível (ex: telefone ausente
 * de um body malformado — nesse caso, a validação Zod do handler já vai
 * rejeitar depois, não precisa contar aqui).
 */
function createRateLimit(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyFn: (req: FastifyRequest) => string | null;
}) {
  return async function rateLimit(req: FastifyRequest, _reply: FastifyReply) {
    const key = opts.keyFn(req);
    if (key === null) return;
    const mapKey = `${opts.keyPrefix}:${key}`;
    const now = Date.now();
    const timestamps = (hits.get(mapKey) ?? []).filter((t) => now - t < opts.windowMs);
    if (timestamps.length >= opts.max) throw Errors.tooManyAttempts();
    timestamps.push(now);
    hits.set(mapKey, timestamps);
  };
}

export async function loginRateLimit(req: FastifyRequest, _reply: FastifyReply) {
  const ip = req.ip;
  const now = Date.now();
  const timestamps = (hits.get(`login:${ip}`) ?? []).filter((t) => now - t < 60_000);
  if (timestamps.length >= 10) throw Errors.tooManyAttempts();
  timestamps.push(now);
  hits.set(`login:${ip}`, timestamps);
}

// ---------- Rotas públicas de self-service (checkout via página/WhatsApp) ----------

// Enumeração de telefone (nome + endereços salvos vazam PII) — limite mais
// apertado que o padrão de escrita, já que é o endpoint mais barato de abusar.
export const publicLookupRateLimit = createRateLimit({ windowMs: 60_000, max: 20, keyPrefix: "lookup-ip", keyFn: (req) => req.ip });

export const publicWriteRateLimit = createRateLimit({ windowMs: 60_000, max: 10, keyPrefix: "write-ip", keyFn: (req) => req.ip });

// Carrinho server-side (rascunho): o PUT do client é debounced (~800ms),
// mas edição contínua de quantidades pode gerar rajadas legítimas — limite
// mais frouxo que o de escrita, ainda assim limitado por IP.
export const publicCartRateLimit = createRateLimit({ windowMs: 60_000, max: 60, keyPrefix: "cart-ip", keyFn: (req) => req.ip });

// Pedido é o mais sensível: cria comanda de verdade e (agora que o notifier
// existe) dispara mensagem pro telefone do cliente. Duplo limite — por IP
// (evita spam de uma origem) E por telefone (evita alguém trocando de IP
// pra encher o telefone de uma vítima de pedidos falsos).
const orderIpRateLimit = createRateLimit({ windowMs: 60_000, max: 5, keyPrefix: "order-ip", keyFn: (req) => req.ip });
const orderPhoneRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 5,
  keyPrefix: "order-phone",
  keyFn: (req) => {
    const phone = (req.body as any)?.customerPhone;
    return typeof phone === "string" && phone.length > 0 ? phone : null;
  },
});
export async function publicOrderRateLimit(req: FastifyRequest, reply: FastifyReply) {
  await orderIpRateLimit(req, reply);
  await orderPhoneRateLimit(req, reply);
}

// ---------- Device provisioning (docs/21 §11) ----------
// O código da chave e o device token têm 80/256 bits de entropia + argon2 —
// brute force já é inviável; o limite apertado (5/min/IP) é a segunda barreira
// no exchange (código digitado) e no refresh do device token.
export const provisioningRateLimit = createRateLimit({ windowMs: 60_000, max: 5, keyPrefix: "prov-ip", keyFn: (req) => req.ip });
