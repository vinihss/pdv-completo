/**
 * Dependências compartilhadas do módulo de identidade centralizada.
 *
 * Mesmo desenho do `login.usecase` (Onda auth): a application não importa
 * `infra/`, `config` nem Drizzle. O `tenant` é resolvido a CADA chamada (nunca
 * memoizado: o ALS muda por request) e o `jwtSecret` chega por injeção — o
 * composition root é o único que lê `config`.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { Mailer } from "../../ports/effects.js";
import type { IdentityTenantReader } from "./identity-tenant-reader.js";

export interface IdentityDependencies {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Empresas vinculadas e usuário por loja (escopo ALS por schema, na infra). */
  tenants: IdentityTenantReader;
  /** Envio do link de recuperação de senha (SMTP ou fake de teste). */
  mailer: Mailer;
  /** Segredo do JWT (a application não lê `config`). */
  jwtSecret: string;
}

/** URL de login/usar a tela, montada na rota (a application não lê `req`). */
export interface RequestOrigin {
  /** Sem barra final — ex.: `https://pdv.loja.com.br`. */
  origin: string;
}
