import type { FastifyRequest, FastifyReply } from "fastify";
import { Errors } from "../../domain/errors.js";

// Rate limit simples em memória, por IP — suficiente para instância única
// (modo local, único processo). Em modo cloud com múltiplas réplicas, isso
// precisaria virar um store compartilhado (Redis); fora de escopo da etapa 1.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const hits = new Map<string, number[]>();

export async function loginRateLimit(req: FastifyRequest, _reply: FastifyReply) {
  const ip = req.ip;
  const now = Date.now();
  const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_REQUESTS) throw Errors.tooManyAttempts();
  timestamps.push(now);
  hits.set(ip, timestamps);
}
