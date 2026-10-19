/**
 * Port de usuários/equipe — login, papéis e estado de tentativas.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/user.repository.ts`) traduz para Drizzle/schema.
 */
import type { Id, UserRole } from "../../ports/repositories/shared.js";

export interface UserRecord {
  id: Id;
  name: string;
  role: UserRole;
  /** Hash argon2 do PIN. O port NÃO gera PIN: o use case hasheia e passa aqui. */
  pinHash: string;
  active: boolean;
  phone: string | null;
  email: string | null;
  /**
   * ADIÇÃO (Onda identidade — docs/26 §3): id da conta GLOBAL deste usuário
   * (`public.account`). `null` = criado antes do backfill. NÃO vai para a
   * apresentação (`serializeUser` não o expõe) — é vínculo interno.
   */
  accountId: string | null;
  photoPath: string | null;
  createdAt: string;
  /**
   * ADIÇÃO (Onda auth — login.usecase): estado de tentativas de login. O use
   * case lê para decidir o lock e grava (incrementa/trava ou zera) por
   * `setLoginState`; o record NÃO era exposto a apresentação.
   */
  failedAttempts: number;
  /** ISO 8601 UTC; `null` quando a conta não está travada. */
  lockedUntil: string | null;
}

export interface UserRepository {
  findById(id: Id): Promise<UserRecord | null>;
  /** Login por id, telefone ou email (case-insensitive) — o use case de login valida PIN/lock depois. */
  findByLogin(login: string): Promise<UserRecord | null>;
  /**
   * Usuários ativos em ordem alfabética (`GET /auth/users` — tela de seleção do
   * login). ADIÇÃO (Onda auth): `photoPath` entra para o serializador do use
   * case montar a URL pública (o record não traz apresentação pronta).
   */
  listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role" | "photoPath">>>;
  /** `input.id` presente = update; ausente = create (exige `pinHash` já argon2-hasheado pelo use case). */
  save(input: Partial<UserRecord> & Pick<UserRecord, "name" | "role">): Promise<UserRecord>;
  /** ADIÇÃO (Onda 3 — self-service): lote por ids (entregadores da listagem de entregas, sem N+1). */
  findByIds(ids: Id[]): Promise<UserRecord[]>;
  /** ADIÇÃO (Onda 3 — self-service): usuários de um papel (`GET /manager/couriers` — inclui inativos). */
  listByRole(role: UserRole): Promise<UserRecord[]>;

  // ---------- ADIÇÕES (Onda auth — user.usecases) ----------
  /** Lista completa, ordem alfabética (`GET /users`, manager-only). */
  list(): Promise<UserRecord[]>;
  /** Usuário por email EXATO (unicidade não-índice — a validação é do use case). */
  findByEmail(email: string): Promise<UserRecord | null>;
  /**
   * Estado de tentativas de login (colunas `failed_attempts`/`locked_until`).
   * Falha incrementa/trava; sucesso zera. Sem `updatedAt` — mesma régua de
   * `countFailedAttempt`/reset do login original.
   */
  setLoginState(id: Id, state: { failedAttempts: number; lockedUntil: string | null }): Promise<void>;
}
