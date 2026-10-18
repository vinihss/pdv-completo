import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../../config/env.js";
import { Errors } from "../../domain/errors.js";
import { assertUserActive } from "../../infra/auth/active-user-check.js";
import { currentTenantScope, ensureTenantScope } from "../../infra/db/tenant-context.js";
import { verifyAccountToken } from "../../application/identity/identity-tokens.js";

export type Role = "waiter" | "kitchen" | "manager" | "courier" | "cashier";

export interface AuthUser {
  sub: string; // user id
  role: Role;
  tenant: string;
}

/** Etapa de CONTA do login novo (docs/26 §4): vale só para trocar senha e escolher empresa. */
export interface AuthAccount {
  id: string; // account id (global)
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    authAccount?: AuthAccount;
  }
}

export async function authMiddleware(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw Errors.unauthorized();
  const token = header.slice("Bearer ".length);
  
  // Garante que o tenant scope esteja ativo antes de verificar o token
  // Workaround para problema de propagação do ALS no Fastify + Node.js 22.x
  const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
  
  return ensureTenantScope(host, async () => {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as AuthUser;

      const tenant = currentTenantScope();
      if (!tenant) {
        throw Errors.unauthorized();
      }
      if (payload.tenant !== tenant.slug) {
        throw Errors.unauthorized();
      }

      req.authUser = payload;
      // JWT é stateless (12h): sem isto, "desativar usuário" não matava sessão
      // aberta. Verifica user.active a cada requisição com cache de ~30s
      // (docs/21 §5.4) — usuário desativado responde 401 como token inválido.
      await assertUserActive(payload.sub);
    } catch {
      throw Errors.unauthorized();
    }
  });
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.authUser) throw Errors.unauthorized();
    if (!roles.includes(req.authUser.role)) throw Errors.forbiddenRole();
  };
}

/**
 * Autenticação da etapa de CONTA (docs/26 §4): aceita SOMENTE o `accountToken`
 * (`typ: "account"`). Usada em `POST /auth/password/change` e
 * `POST /auth/select-tenant` — as duas únicas rotas que valem antes de existir
 * sessão de loja.
 *
 * A separação é dos dois lados: aqui o `typ` é obrigatório (o token de tenant
 * não tem o claim e cai em 401), e no `authMiddleware` de tenant o
 * `payload.tenant` é comparado com o escopo do host — o `accountToken` não tem
 * `tenant` e também cai em 401. Nenhum token serve no lugar do outro.
 */
export async function accountAuthMiddleware(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw Errors.unauthorized();
  const claims = verifyAccountToken(header.slice("Bearer ".length), config.jwtSecret);
  if (!claims) throw Errors.unauthorized();
  req.authAccount = { id: claims.sub };
}

export function verifyTokenRaw(token: string): AuthUser {
  return jwt.verify(token, config.jwtSecret) as AuthUser;
}
