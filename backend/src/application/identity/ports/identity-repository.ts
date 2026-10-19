/**
 * Port das tabelas GLOBAIS de identidade (`public.account`, `public.auth_session`
 * e `public.password_reset`) — `docs/26-identidade-centralizada.md` §3.
 *
 * Estas tabelas NÃO pertencem a nenhum schema de tenant: a identidade (quem é a
 * pessoa) é global, e o vínculo por loja (a linha em `user`, dona do `role`) é
 * por schema. O adapter implementa o SQL CRU qualificado com `public.` sobre a
 * MESMA transação da sessão de tenant — é isso que torna o convite
 * (`POST /users`) atômico: conta global + linha `user` + envio de email no mesmo
 * commit, e um erro em qualquer passo não deixa nem conta nem usuário para trás
 * (decisão 9 do §2).
 *
 * O port NÃO conhece argon2, JWT, hash de token nem relógio: o use case hasheia
 * (`argon2`), assina e decide os prazos; aqui só entra/trava o que já veio
 * pronto. Todo timestamp é TEXT ISO-8601 UTC no formato que o schema usa
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`), comparável por ordem lexicográfica.
 */
import type { Id } from "../../ports/repositories/shared.js";

export type AccountStatus = "active" | "suspended";

export interface AccountRecord {
  id: Id;
  email: string;
  /** `null` = convite pendente/backfill (não autentica por senha — §11). */
  passwordHash: string | null;
  name: string | null;
  status: AccountStatus;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: Id;
  accountId: Id;
  deviceId: string | null;
  /** Último tenant selecionado; `null` enquanto nenhuma empresa foi escolhida. */
  tenantSlug: string | null;
  expiresAt: string;
  revokedAt: string | null;
  /** Cadeia de rotação (`rotated_from` da sessão que originou esta). */
  rotatedFrom: Id | null;
  createdAt: string;
}

export interface PasswordResetRecord {
  id: Id;
  accountId: Id;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface IdentityRepository {
  // ---------- account ----------

  /** Busca por email CASE-INSENSITIVE (índice único `lower(email)`). */
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  findAccountById(id: Id): Promise<AccountRecord | null>;
  /**
   * Cria a conta se ainda não existir (por `lower(email)`) e devolve a linha —
   * nova ou a existente, INTACTA (sem mexer em senha). `password_hash` nasce
   * `NULL` (dormant/convite pendente); quem define credencial é
   * `setAccountPassword`. Idempotente: email repetido em outra loja cai na
   * MESMA conta (§4).
   */
  ensureAccount(input: { id: Id; email: string; name?: string | null; now: string }): Promise<AccountRecord>;
  /** Define a senha (argon2 já hasheado pelo use case) e o flag de troca obrigatória. */
  setAccountPassword(id: Id, input: { passwordHash: string; mustChangePassword: boolean; now: string }): Promise<void>;

  // ---------- auth_session ----------

  createAuthSession(input: {
    id: Id;
    accountId: Id;
    refreshHash: string;
    tenantSlug?: string | null;
    deviceId?: string | null;
    expiresAt: string;
    rotatedFrom?: Id | null;
    now: string;
  }): Promise<AuthSessionRecord>;
  findAuthSessionByHash(refreshHash: string): Promise<AuthSessionRecord | null>;
  /**
   * CLAIM atômico do refresh (rotação sem corrida): revoga a sessão VIVA com
   * este hash (`revoked_at IS NULL` e `expires_at > now`) e devolve a linha
   * revogada; `null` = hash desconhecido, já revogado ou expirado. É o único
   * ponto que decide quem ganha a rotação — dois cliques simultâneos no botão
   * não geram duas sessões vivas.
   */
  claimAuthSession(refreshHash: string, now: string): Promise<AuthSessionRecord | null>;
  /** Revoga a família inteira (a sessão + todos os descendentes por `rotated_from`). */
  revokeAuthSessionFamily(id: Id, now: string): Promise<number>;
  /** Revoga a sessão do hash (logout). Idempotente — sem linha viva, nada muda. */
  revokeAuthSessionByHash(refreshHash: string, now: string): Promise<void>;
  /** Cascata de segurança (reset de senha): derruba TODAS as sessões da conta. */
  revokeAllAuthSessions(accountId: Id, now: string): Promise<number>;

  // ---------- password_reset ----------

  createPasswordReset(input: {
    id: Id;
    accountId: Id;
    tokenHash: string;
    expiresAt: string;
    now: string;
  }): Promise<PasswordResetRecord>;
  findPasswordResetByHash(tokenHash: string): Promise<PasswordResetRecord | null>;
  /**
   * Claim de uso único (`UPDATE ... SET used_at = $now WHERE id = $1 AND used_at
   * IS NULL`): `false` = outra requisição já consumiu o token.
   */
  claimPasswordResetUsage(id: Id, usedAt: string): Promise<boolean>;
  /** Invalida os pedidos pendentes da conta (novo pedido ou troca de senha). */
  invalidatePendingPasswordResets(accountId: Id, usedAt: string): Promise<number>;
}
