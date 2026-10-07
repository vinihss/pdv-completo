import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../../config/env.js";
import { Errors } from "../../domain/errors.js";
import { assertUserActive } from "../../infra/auth/active-user-check.js";

export type Role = "waiter" | "kitchen" | "manager" | "courier" | "cashier";

export interface AuthUser {
  sub: string; // user id
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export async function authMiddleware(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw Errors.unauthorized();
  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.authUser = payload;
    // JWT é stateless (12h): sem isto, "desativar usuário" não matava sessão
    // aberta. Verifica user.active a cada requisição com cache de ~30s
    // (docs/21 §5.4) — usuário desativado responde 401 como token inválido.
    await assertUserActive(payload.sub);
  } catch {
    throw Errors.unauthorized();
  }
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.authUser) throw Errors.unauthorized();
    if (!roles.includes(req.authUser.role)) throw Errors.forbiddenRole();
  };
}

export function verifyTokenRaw(token: string): AuthUser {
  return jwt.verify(token, config.jwtSecret) as AuthUser;
}
