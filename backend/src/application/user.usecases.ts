// Use cases de equipe (usuários) — CRUD + PIN + foto + seleção do login.
//
// Migrado para ports + Unit-of-Work (Onda auth): nenhuma importação de
// infra/integrations/config nem de Drizzle. Toda persistência sai por
// `session.users`/`session.userDevices`/`session.storeSettings`, o audit e o
// outbox pela própria sessão (MESMA transação) e o storage de foto é um port
// (`FileStorage`) injetado via `deps`. O composition root que liga os adapters
// concretos é `infra/composition/default-usecases.ts`.
//
// NOTA sobre async: dentro de `deps.uow.run` todo acesso ao `session` é uma
// Promise — sempre `await`. Esquecer o await emitiria o UPDATE depois do
// COMMIT e a escrita se perderia em silêncio. O `throw` continua sendo o
// mecanismo de rollback.
import argon2 from "argon2";
import { Errors } from "../domain/errors.js";
import type { TenantUnitOfWork, TenantSession } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { FileStorage } from "./ports/effects.js";
import type { UserRecord } from "./ports/repositories.js";

export type UserRole = "waiter" | "kitchen" | "manager" | "courier" | "cashier";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- helpers puros (eram infra/storage) ----------
//
// `storageAssetPath`/`isSafeFilename`/`storageFilename` são funções PURAS de
// `infra/storage` (sem I/O). Replicadas aqui para a application não importar a
// camada de armazenamento — o `FileStorage` port (put/remove) é a única seam
// de I/O (mesmo desenho de `customer.usecases.ts`).

const UPLOADS_PREFIX = "/uploads";

/** Domínios de foto cujo caminho público é `/uploads/<kind>/<filename>`. */
type PhotoKind = "product" | "logo" | "customer" | "user";

/**
 * O banco guarda só o nome do arquivo; quem consome a API precisa do caminho
 * público. Fonte única do prefixo — a foto é servida em `/uploads/` sem auth
 * (o mesmo argumento das fotos de produto), então isso vale inclusive para as
 * rotas públicas do login.
 *
 * O `kind` é explícito porque `user.photo_path` e `customer.photo_path` são
 * colunas diferentes apontando para o mesmo formato: `/uploads/<kind>/<arquivo>`.
 */
export function photoUrl(photoPath: string | null | undefined, kind: PhotoKind): string | null {
  return photoPath ? `${UPLOADS_PREFIX}/${kind}/${photoPath}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

// ---------- serialização / normalizações (mesmas do módulo original) ----------

function serialize(u: UserRecord) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    active: u.active,
    phone: u.phone ?? null,
    email: u.email ?? null,
    photoPath: photoUrl(u.photoPath, "user"),
    createdAt: u.createdAt,
  };
}

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 10 || digits.length > 11) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

async function assertEmailAvailable(session: TenantSession, email: string | null | undefined, exceptUserId?: string) {
  if (!email) return;
  const clash = await session.users.findByEmail(email);
  if (clash && clash.id !== exceptUserId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

export interface UserUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Upload/remoção da foto do usuário em disco. */
  storage: FileStorage;
  /**
   * Invalida o cache de "usuário ativo" do middleware (infra/auth) na cascata
   * de desativação — a sessão JWT aberta cai na próxima requisição.
   */
  invalidateActiveUser: (userId: string) => void;
}

export function createUserUsecases(deps: UserUsecasesDeps) {
  return {
    /** `GET /users` (manager): lista completa, ordem alfabética. */
    async listUsersUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.users.list();
        return rows.map(serialize);
      });
    },

    /** `POST /users` (manager): cria com PIN aleatório (retornado uma única vez). */
    async createUserUsecase(input: {
      name: string;
      role: UserRole;
      phone?: string | null;
      email?: string | null;
    }) {
      const email = normalizeEmail(input.email);
      const phoneDigits = normalizePhone(input.phone);
      const pin = randomPin();
      const pinHash = await argon2.hash(pin);
      const created = await deps.uow.run(deps.tenant(), async (session) => {
        await assertEmailAvailable(session, email);
        return session.users.save({ name: input.name, role: input.role, pinHash, phone: phoneDigits, email });
      });
      return { ...serialize(created), pin }; // PIN em texto puro, uma única vez, pra exibição ao gerente
    },

    /** `PATCH /users/:id` (manager): update parcial + cascata de desativação. */
    async updateUserUsecase(
      id: string,
      input: {
        name?: string;
        role?: UserRole;
        active?: boolean;
        phone?: string | null;
        email?: string | null;
        pin?: string;
      },
      actorId?: string,
    ) {
      const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
      const phoneDigits = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

      // PIN manual (4-6 dígitos): mesma regra do reset-pin — troca o hash e
      // desbloqueia a conta. O reset-pin continua existindo para gerar um PIN
      // aleatório.
      let pinHash: string | undefined;
      if (input.pin !== undefined) {
        const digits = input.pin.replace(/\D/g, "");
        if (digits.length < 4 || digits.length > 6) throw Errors.validationFailed({ field: "pin" });
        pinHash = await argon2.hash(digits);
      }

      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");
        if (input.email !== undefined) await assertEmailAvailable(session, email, id);

        // Desativar usuário é a lacuna fechada do docs/21 §5.4: além do login
        // negar, os aparelhos provisionados do usuário são revogados NA MESMA
        // transação (+ audit + evento pro gerente) e o cache de sessão aberta do
        // middleware é invalidado. Reativar NÃO devolve aparelhos (decisão do
        // plano — exige novo provisionamento).
        const deactivating = input.active === false && existing.active === true;

        const row = await session.users.save({
          id,
          name: input.name ?? existing.name,
          role: input.role ?? existing.role,
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(phoneDigits !== undefined ? { phone: phoneDigits } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(pinHash !== undefined ? { pinHash } : {}),
        });

        if (deactivating) {
          const revokedDevices = await session.userDevices.revokeAll(id, new Date().toISOString());
          await session.audit.record({
            actorId: actorId ?? id,
            action: "user_access_toggled",
            orderId: null,
            details: { userId: id, active: false, revokedDevices },
          });
          await session.outbox.enqueue({
            room: "alerts:manager",
            type: "user_access_changed",
            aggregateId: id,
            payload: { userId: id, active: false, revokedDevices },
          });
          // Sessões JWT abertas caem na próxima requisição (não espera os 30s do cache).
          deps.invalidateActiveUser(id);
        }
        return row;
      });
      return serialize(updated);
    },

    /**
     * Leitura do próprio perfil (GET /auth/me): o mesmo `serialize` do PATCH,
     * para a tela de perfil abrir com telefone/e-mail reais — o login devolve só
     * `{ id, name, role, photoPath }` e inicializar o formulário com a sessão
     * deixaria os campos vazios (um salvar apagaria o que já está no banco).
     * 404 quando o usuário do token não existe mais (mesma régua do PATCH).
     */
    async getOwnProfileUsecase(id: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");
        return serialize(existing);
      });
    },

    /**
     * Self-service de perfil (PATCH /auth/me): o usuário logado atualiza os
     * PRÓPRIOS dados de contato — `name`, `phone` e `email`.
     *
     * O id vem do token, nunca do body, e o conjunto de campos é fechado por
     * construção — `role`, `active` e `pin` nem entram na assinatura. Audit log
     * na MESMA transação do UPDATE.
     */
    async updateOwnProfileUsecase(
      id: string,
      input: { name: string; phone?: string | null; email?: string | null },
    ) {
      const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
      const phoneDigits = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");
        if (input.email !== undefined) await assertEmailAvailable(session, email, id);

        const row = await session.users.save({
          id,
          name: input.name,
          role: existing.role,
          ...(phoneDigits !== undefined ? { phone: phoneDigits } : {}),
          ...(email !== undefined ? { email } : {}),
        });
        await session.audit.record({
          actorId: id,
          action: "user_profile_updated",
          orderId: null,
          details: {
            userId: id,
            fields: [
              "name",
              ...(phoneDigits !== undefined ? ["phone"] : []),
              ...(email !== undefined ? ["email"] : []),
            ],
          },
        });
        return row;
      });
      return serialize(updated);
    },

    /** `PATCH /users/:id/reset-pin` (manager): PIN aleatório, retornado uma vez. */
    async resetPinUsecase(id: string) {
      const pin = randomPin();
      const pinHash = await argon2.hash(pin);
      await deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");
        await session.users.save({ id, name: existing.name, role: existing.role, pinHash });
      });
      return { pin };
    },

    /**
     * `GET /auth/users` (público, tela de seleção do login): só ativos e
     * respeitando os toggles de rollout — esconde "kitchen" quando
     * kitchen_enabled=false e "courier" quando uses_delivery=false.
     */
    async listActiveUsersUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const settings = await session.storeSettings.findSingleton();
        const rows = await session.users.listActive();
        return rows
          .filter((u) => settings?.kitchenEnabled || u.role !== "kitchen")
          .filter((u) => settings?.usesDelivery !== false || u.role !== "courier")
          .map((u) => ({ id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath, "user") }));
      });
    },

    // ---------- Foto (upload em disco, caminho gravado em user.photo_path) ----------
    //
    // Mesmo desenho das fotos de cliente/produto: nome de arquivo GERADO pelo
    // app a partir do id (o nome enviado pelo cliente nunca vira caminho em
    // disco), o nome gravado no banco é só o basename, arquivo antigo removido
    // quando a extensão muda, e o audit na mesma transação do UPDATE.

    /** `POST /users/:id/photo` e `/auth/me/photo`. */
    async saveUserPhotoUsecase(id: string, input: { buffer: Buffer; ext: string }, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");

        const filename = `${id}.${input.ext}`;
        if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
        await deps.storage.put("user", filename, input.buffer);

        const previous = storageFilename(existing.photoPath);
        if (previous && previous !== filename) await deps.storage.remove("user", previous);

        const updated = await session.users.save({ id, name: existing.name, role: existing.role, photoPath: filename });
        await session.audit.record({
          actorId,
          action: "user_photo_changed",
          orderId: null,
          details: { userId: id },
        });
        return serialize(updated);
      });
    },

    /** `DELETE /users/:id/photo` e `/auth/me/photo`. */
    async clearUserPhotoUsecase(id: string, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.users.findById(id);
        if (!existing) throw Errors.notFound("Usuário");
        const previous = storageFilename(existing.photoPath);
        if (previous) await deps.storage.remove("user", previous);

        const updated = await session.users.save({ id, name: existing.name, role: existing.role, photoPath: null });
        await session.audit.record({
          actorId,
          action: "user_photo_removed",
          orderId: null,
          details: { userId: id },
        });
        return serialize(updated);
      });
    },
  };
}

export type UserUsecases = ReturnType<typeof createUserUsecases>;
