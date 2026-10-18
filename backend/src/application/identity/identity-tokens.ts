/**
 * Assinatura/verificação dos JWTs da identidade centralizada (§4).
 *
 * Dois tokens com propósitos DIFERENTES moram no mesmo segredo:
 * - `accountToken` = `{ sub: accountId, typ: "account" }` (10min) — vale só para
 *   `POST /auth/password/change` e `POST /auth/select-tenant`;
 * - token de tenant = `{ sub: userId, role, tenant }` (12h) — o formato ATUAL,
 *   inalterado, consumido pelo `auth.middleware` existente.
 *
 * O `typ` é o que separa os domínios: o middleware de tenant compara
 * `payload.tenant` com o escopo do host (accountToken não tem `tenant` → 401),
 * e o middleware de conta exige `typ === "account"` (token de tenant não tem o
 * claim → 401). Nenhum dos dois aceita o token do outro.
 */
import jwt from "jsonwebtoken";
import { ACCOUNT_TOKEN_TTL, TENANT_TOKEN_TTL } from "./identity-helpers.js";

export const ACCOUNT_TOKEN_TYPE = "account";

export interface AccountTokenClaims {
  sub: string;
  typ: typeof ACCOUNT_TOKEN_TYPE;
}

/** Claims do token de tenant — mesmo formato do login por PIN. */
export interface TenantTokenClaims {
  sub: string;
  role: string;
  tenant: string;
}

export function signAccountToken(accountId: string, secret: string): string {
  return jwt.sign({ sub: accountId, typ: ACCOUNT_TOKEN_TYPE }, secret, { expiresIn: ACCOUNT_TOKEN_TTL });
}

/** `null` = assinatura inválida, expirado ou `typ` diferente de `account`. */
export function verifyAccountToken(token: string, secret: string): AccountTokenClaims | null {
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === "string") return null;
    if (payload.typ !== ACCOUNT_TOKEN_TYPE) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { sub: payload.sub, typ: ACCOUNT_TOKEN_TYPE };
  } catch {
    return null;
  }
}

export function signTenantToken(claims: TenantTokenClaims, secret: string): string {
  return jwt.sign({ sub: claims.sub, role: claims.role, tenant: claims.tenant }, secret, {
    expiresIn: TENANT_TOKEN_TTL,
  });
}
