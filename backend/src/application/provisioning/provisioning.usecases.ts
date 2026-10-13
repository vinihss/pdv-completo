import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { Errors } from "../../domain/errors.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { ProvisioningKeyRecord } from "../ports/repositories.js";
import { photoUrl } from "../user.usecases.js";
import { revokeActiveKey } from "./device-state.js";

// Device provisioning (docs/21-device-provisioning.md) — PR 1.
//
// O segredo (código da chave / device token) existe em texto puro SÓ na
// resposta do momento da geração: no banco vive apenas o hash argon2. O JWT
// emitido aqui tem exatamente o contrato do login ({sub, role}, 12h) — nada de
// claim novo (Fase 1 do multi-tenant, docs/15 §4.5).
//
// Migrado para ports + Unit-of-Work: a persistência sai por `session.provisioningKeys`/
// `session.userDevices`, o audit/outbox pela própria sessão (mesma transação) e
// o segredo do JWT é injetado via `deps` (a application não lê `config`).

const ALERTS_MANAGER_ROOM = "alerts:manager";
const DEVICE_TOKEN_BYTES = 32;
const KEY_RANDOM_CHARS = 16;
const DEVICE_JWT_TTL = "12h";
const REVOKED_GRACE_MS = 60 * 60_000; // janela em que uma chave recém-revogada ainda é reconhecível

// RFC 4648 base32 (A-Z, 2-7): legível e sem caracteres ambíguos.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const nowIso = () => new Date().toISOString();

function randomBase32(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32_ALPHABET[bytes[i] % 32];
  return out;
}

/**
 * Código canônico da chave: `PDV` + 16 chars base32, sem hífen
 * ("PDVABCDEFGHIJKLMNOP"). É esta forma que o argon2 hasheia — o hífen é
 * apresentação (formatação em grupos de 4). 16 chars × 5 bits = 80 bits de
 * entropia; a §4 do plano anuncia 128 bits mas fixa o formato legível
 * `PDV-XXXX-XXXX-XXXX-XXXX` — ver relatório do PR (divergência anotada).
 */
function generateProvisioningCode(): string {
  return `PDV${randomBase32(KEY_RANDOM_CHARS)}`;
}

/** "PDVABCDEFGHIJKLMNOP" → "PDV-ABCD-EFGH-IJKL-MNOP" (exibição/QR). */
export function formatProvisioningCode(code: string): string {
  const body = code.startsWith("PDV") ? code.slice("PDV".length) : code;
  const groups = body.match(/.{1,4}/g) ?? [];
  return ["PDV", ...groups].join("-");
}

/**
 * Normaliza o código como digitado/escaneado: caixa alta e só alfanumérico
 * (aceita "pdv-abcd-…" minúsculo e "PDVABCD…" sem hífen).
 */
export function normalizeProvisioningCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function randomDeviceToken(): string {
  return crypto.randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
}

export interface ProvisioningUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Segredo do JWT (`config.jwtSecret`) — injetado para a application não ler `config`. */
  jwtSecret: string;
}

export function createProvisioningUsecases(deps: ProvisioningUsecasesDeps) {
  // -------------------------------------------------------------------------
  // Chave de provisionamento (gerente)
  // -------------------------------------------------------------------------
  async function generateProvisioningKeyUsecase(input: {
    userId: string;
    createdBy: string;
    expiresAt?: string | null;
  }) {
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (Number.isNaN(Date.parse(input.expiresAt))) {
        throw Errors.validationFailed({ field: "expiresAt" });
      }
    }

    const code = generateProvisioningCode();
    const codeHash = await argon2.hash(code);
    const now = nowIso();

    return deps.uow.run(deps.tenant(), async (session) => {
      const user = await session.users.findById(input.userId);
      if (!user) throw Errors.notFound("Usuário");

      // Gira: revoga a chave ativa anterior do usuário e cria a nova. O índice
      // único parcial `uq_provisioning_key_active` garante o "no máximo 1 ativa";
      // o ON CONFLICT DO NOTHING cobre a corrida de dois gerentes — o perdedor
      // não devolve código nenhum em vez de estourar 500 cru.
      await revokeActiveKey(session, input.userId, now);
      const created = await session.provisioningKeys.create({
        userId: input.userId,
        codeHash,
        codeHint: code.slice(-4),
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      });
      if (!created) {
        throw Errors.serviceUnavailable("Não foi possível gerar a chave. Tente novamente.");
      }
      await session.audit.record({
        actorId: input.createdBy,
        action: "provisioning_key_generated",
        orderId: null,
        details: { userId: input.userId, keyId: created.id },
      });

      const display = formatProvisioningCode(code);
      return {
        keyId: created.id,
        code: display,
        qrPayload: `PDVPROV1:${display}`,
        expiresAt: created.expiresAt,
        hint: created.codeHint,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Exchange (aberturas seguintes — público)
  // -------------------------------------------------------------------------
  async function exchangeProvisioningCodeUsecase(input: {
    code: string;
    platform: "android" | "ios" | "web" | "desktop";
    appProfile: "pdv" | "kds";
    deviceLabel?: string | null;
  }) {
    const canonical = normalizeProvisioningCode(input.code);
    const cutoff = new Date(Date.now() - REVOKED_GRACE_MS).toISOString();
    const now = nowIso();

    return deps.uow.run(deps.tenant(), async (session) => {
      // O código não tem coluna de lookup (só o hash argon2 está no banco), então
      // o match é por verificação: varre as chaves vivas (não revogadas, ou
      // revogadas há pouco tempo — janela em que "chave girada" ainda responde
      // `revoked` em vez de `invalid`) e verifica TODAS, para o tempo não vazar
      // qual chave casou. Com dezenas de usuários e o rate limit de 5/min/IP o
      // custo é irrelevante.
      const candidates = await session.provisioningKeys.listCandidates(cutoff);

      let matched: ProvisioningKeyRecord | null = null;
      for (const key of candidates) {
        if (await argon2.verify(key.codeHash, canonical)) matched = key;
      }
      if (!matched) throw Errors.provisioningKeyInvalid();
      if (matched.revokedAt) throw Errors.provisioningKeyRevoked();
      if (matched.expiresAt && matched.expiresAt <= now) throw Errors.provisioningKeyExpired();

      const user = await session.users.findById(matched.userId);
      // Usuário desativado não ganha aparelho novo (a reativação não devolve
      // os antigos, então provisionar agora seria criar algo revogado na hora).
      if (!user || !user.active) throw Errors.provisioningKeyInvalid();

      const rawToken = randomDeviceToken();
      const deviceSecretHash = await argon2.hash(rawToken);
      const nowAt = nowIso();
      const dev = await session.userDevices.create({
        userId: user.id,
        provisioningKeyId: matched.id,
        label: input.deviceLabel ?? null,
        platform: input.platform,
        appProfile: input.appProfile,
        deviceSecretHash,
        createdAt: nowAt,
        updatedAt: nowAt,
      });

      await session.audit.record({
        actorId: user.id,
        action: "device_provisioned",
        orderId: null,
        details: {
          deviceId: dev.id,
          platform: input.platform,
          appProfile: input.appProfile,
          label: input.deviceLabel ?? null,
        },
      });
      await session.outbox.enqueue({
        room: ALERTS_MANAGER_ROOM,
        type: "device_provisioned",
        aggregateId: dev.id,
        payload: {
          deviceId: dev.id,
          userId: user.id,
          userName: user.name,
          label: input.deviceLabel ?? null,
          platform: input.platform,
          appProfile: input.appProfile,
        },
      });

      // Texto puro do device token: só esta resposta.
      return {
        deviceId: dev.id,
        deviceToken: rawToken,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          photoPath: photoUrl(user.photoPath, "user"),
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Refresh (aberturas seguintes — público)
  // -------------------------------------------------------------------------
  async function refreshDeviceSessionUsecase(input: {
    deviceId: string;
    deviceToken: string;
    ip?: string;
  }) {
    const result = await deps.uow.run(deps.tenant(), async (session) => {
      const dev = await session.userDevices.findById(input.deviceId);
      if (!dev) throw Errors.deviceUnknown();
      if (!dev.active || dev.revokedAt) throw Errors.deviceRevoked();

      let valid = false;
      try {
        valid = await argon2.verify(dev.deviceSecretHash, input.deviceToken);
      } catch {
        valid = false; // hash corrompido/legado = token inválido
      }
      if (!valid) throw Errors.deviceUnknown(); // token errado: mesmo erro de aparelho desconhecido

      const user = await session.users.findById(dev.userId);
      if (!user || !user.active) throw Errors.invalidCredentials();

      // Rotaciona o device token (hash novo gravado, texto puro só na resposta)
      // e atualiza last_seen_at. O WHERE restrito a `active = true` revoga a
      // corrida com um DELETE concorrente: se o aparelho foi revogado entre a
      // leitura e a escrita, nada é atualizado e cai em `device_revoked`.
      const now = nowIso();
      const newToken = randomDeviceToken();
      const rotated = await session.userDevices.rotateToken(input.deviceId, {
        deviceSecretHash: await argon2.hash(newToken),
        lastSeenAt: now,
        updatedAt: now,
      });
      if (!rotated) throw Errors.deviceRevoked();

      return { user, newToken };
    });

    const token = jwt.sign({ sub: result.user.id, role: result.user.role }, deps.jwtSecret, {
      expiresIn: DEVICE_JWT_TTL,
    });
    return {
      token,
      deviceToken: result.newToken,
      user: {
        id: result.user.id,
        name: result.user.name,
        role: result.user.role,
        photoPath: photoUrl(result.user.photoPath, "user"),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Login com aparelho vinculado (POST /auth/login com deviceId opcional)
  // -------------------------------------------------------------------------

  /**
   * Valida o vínculo aparelho→usuário no login por PIN: aparelho conhecido,
   * ativo, não revogado e pertencente ao `userId` que está logando. Sem
   * `deviceId` o login mantém o comportamento atual (PWA/tablet compartilhado).
   * Atualiza `last_seen_at` sem audit (a mesma régua do refresh — seria ruído).
   */
  async function assertDeviceForLogin(userId: string, deviceId: string): Promise<void> {
    await deps.uow.run(deps.tenant(), async (session) => {
      const dev = await session.userDevices.findById(deviceId);
      if (!dev) throw Errors.deviceUnknown();
      if (dev.userId !== userId) throw Errors.deviceNotProvisioned();
      if (!dev.active || dev.revokedAt) throw Errors.deviceRevoked();
      await session.userDevices.touchLastSeen(deviceId, nowIso());
    });
  }

  // -------------------------------------------------------------------------
  // Gestão de aparelhos (manager)
  // -------------------------------------------------------------------------
  async function listUserDevicesUsecase(userId: string) {
    return deps.uow.run(deps.tenant(), async (session) => {
      const user = await session.users.findById(userId);
      if (!user) throw Errors.notFound("Usuário");
      const rows = await session.userDevices.listByUser(userId);
      return rows.map((d) => ({
        id: d.id,
        label: d.label,
        platform: d.platform,
        appProfile: d.appProfile,
        active: d.active,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt,
        createdAt: d.createdAt,
      }));
    });
  }

  async function revokeDeviceUsecase(input: { deviceId: string; actorId: string }) {
    await deps.uow.run(deps.tenant(), async (session) => {
      const dev = await session.userDevices.findById(input.deviceId);
      if (!dev) throw Errors.deviceUnknown();
      if (!dev.active || dev.revokedAt) return; // já revogado — idempotente, sem audit duplicado

      const now = nowIso();
      await session.userDevices.revoke(input.deviceId, now);
      await session.audit.record({
        actorId: input.actorId,
        action: "device_revoked",
        orderId: null,
        details: { userId: dev.userId, deviceId: dev.id, label: dev.label },
      });
      await session.outbox.enqueue({
        room: ALERTS_MANAGER_ROOM,
        type: "device_revoked",
        aggregateId: dev.id,
        payload: { deviceId: dev.id, userId: dev.userId, label: dev.label },
      });
    });
  }

  return {
    generateProvisioningKeyUsecase,
    exchangeProvisioningCodeUsecase,
    refreshDeviceSessionUsecase,
    assertDeviceForLogin,
    listUserDevicesUsecase,
    revokeDeviceUsecase,
  };
}
