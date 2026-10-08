import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { db, type Tx } from "../../infra/db/client.js";
import { users, provisioningKeys, userDevices } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { config } from "../../config/env.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { photoUrl } from "../user.usecases.js";
import { revokeActiveKeyTx } from "./device-state.js";

// Device provisioning (docs/21-device-provisioning.md) — PR 1.
//
// O segredo (código da chave / device token) existe em texto puro SÓ na
// resposta do momento da geração: no banco vive apenas o hash argon2. O JWT
// emitido aqui tem exatamente o contrato do login ({sub, role}, 12h) — nada de
// claim novo (Fase 1 do multi-tenant, docs/15 §4.5).

const ALERTS_MANAGER_ROOM = "alerts:manager";
const DEVICE_TOKEN_BYTES = 32;
const KEY_RANDOM_CHARS = 16;
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

// ---------------------------------------------------------------------------
// Chave de provisionamento (gerente)
// ---------------------------------------------------------------------------

export async function generateProvisioningKeyUsecase(input: {
  userId: string;
  createdBy: string;
  expiresAt?: string | null;
}) {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user) throw Errors.notFound("Usuário");

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (Number.isNaN(Date.parse(input.expiresAt))) {
      throw Errors.validationFailed({ field: "expiresAt" });
    }
  }

  const code = generateProvisioningCode();
  const codeHash = await argon2.hash(code);
  const now = nowIso();

  const key = await db.transaction(async (tx: Tx) => {
    // Gira: revoga a chave ativa anterior do usuário e cria a nova. O índice
    // único parcial `uq_provisioning_key_active` garante o "no máximo 1 ativa";
    // o ON CONFLICT DO NOTHING cobre a corrida de dois gerentes — o perdedor
    // não devolve código nenhum em vez de estourar 500 cru.
    await revokeActiveKeyTx(tx, input.userId, now);
    const [created] = await tx
      .insert(provisioningKeys)
      .values({
        userId: input.userId,
        codeHash,
        codeHint: code.slice(-4),
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      throw Errors.serviceUnavailable("Não foi possível gerar a chave. Tente novamente.");
    }
    await logAction(tx, input.createdBy, "provisioning_key_generated", null, {
      userId: input.userId,
      keyId: created.id,
    });
    return created;
  });

  const display = formatProvisioningCode(code);
  return {
    keyId: key.id,
    code: display,
    qrPayload: `PDVPROV1:${display}`,
    expiresAt: key.expiresAt,
    hint: key.codeHint,
  };
}

// ---------------------------------------------------------------------------
// Exchange (primeiro acesso do aparelho — público)
// ---------------------------------------------------------------------------

export async function exchangeProvisioningCodeUsecase(input: {
  code: string;
  platform: "android" | "ios" | "web" | "desktop";
  appProfile: "pdv" | "kds";
  deviceLabel?: string | null;
}) {
  const canonical = normalizeProvisioningCode(input.code);

  // O código não tem coluna de lookup (só o hash argon2 está no banco), então
  // o match é por verificação: varre as chaves vivas (não revogadas, ou
  // revogadas há pouco tempo — janela em que "chave girada" ainda responde
  // `revoked` em vez de `invalid`) e verifica TODAS, para o tempo não vazar
  // qual chave casou. Com dezenas de usuários e o rate limit de 5/min/IP o
  // custo é irrelevante.
  const cutoff = new Date(Date.now() - REVOKED_GRACE_MS).toISOString();
  const now = nowIso();
  const candidates = await db
    .select()
    .from(provisioningKeys)
    .where(
      and(
        or(isNull(provisioningKeys.revokedAt), gt(provisioningKeys.revokedAt, cutoff)),
        or(isNull(provisioningKeys.expiresAt), gt(provisioningKeys.expiresAt, cutoff)),
      ),
    );

  let matched: (typeof provisioningKeys.$inferSelect) | null = null;
  for (const key of candidates) {
    if (await argon2.verify(key.codeHash, canonical)) matched = key;
  }
  if (!matched) throw Errors.provisioningKeyInvalid();
  if (matched.revokedAt) throw Errors.provisioningKeyRevoked();
  if (matched.expiresAt && matched.expiresAt <= now) throw Errors.provisioningKeyExpired();

  const device = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, matched!.userId));
    // Usuário desativado não ganha aparelho novo (a reativação não devolve
    // os antigos, então provisionar agora seria criar algo revogado na hora).
    if (!user || !user.active) throw Errors.provisioningKeyInvalid();

    const rawToken = randomDeviceToken();
    const deviceSecretHash = await argon2.hash(rawToken);
    const nowAt = nowIso();
    const [dev] = await tx
      .insert(userDevices)
      .values({
        userId: user.id,
        provisioningKeyId: matched!.id,
        label: input.deviceLabel ?? null,
        platform: input.platform,
        appProfile: input.appProfile,
        deviceSecretHash,
        createdAt: nowAt,
        updatedAt: nowAt,
      })
      .returning();

    await logAction(tx, user.id, "device_provisioned", null, {
      deviceId: dev.id,
      platform: input.platform,
      appProfile: input.appProfile,
      label: input.deviceLabel ?? null,
    });
    await enqueueEvent(tx, ALERTS_MANAGER_ROOM, "device_provisioned", {
      deviceId: dev.id,
      userId: user.id,
      userName: user.name,
      label: input.deviceLabel ?? null,
      platform: input.platform,
      appProfile: input.appProfile,
    });
    return { dev, user, rawToken };
  });

  // Texto puro do device token: só esta resposta.
  return {
    deviceId: device.dev.id,
    deviceToken: device.rawToken,
    user: {
      id: device.user.id,
      name: device.user.name,
      role: device.user.role,
      photoPath: photoUrl(device.user.photoPath, "user"),
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh (aberturas seguintes — público)
// ---------------------------------------------------------------------------

export async function refreshDeviceSessionUsecase(input: {
  deviceId: string;
  deviceToken: string;
  ip?: string;
}) {
  const result = await db.transaction(async (tx) => {
    const [dev] = await tx.select().from(userDevices).where(eq(userDevices.id, input.deviceId));
    if (!dev) throw Errors.deviceUnknown();
    if (!dev.active || dev.revokedAt) throw Errors.deviceRevoked();

    let valid = false;
    try {
      valid = await argon2.verify(dev.deviceSecretHash, input.deviceToken);
    } catch {
      valid = false; // hash corrompido/legado = token inválido
    }
    if (!valid) throw Errors.deviceUnknown(); // token errado: mesmo erro de aparelho desconhecido

    const [user] = await tx.select().from(users).where(eq(users.id, dev.userId));
    if (!user || !user.active) throw Errors.invalidCredentials();

    // Rotaciona o device token (hash novo gravado, texto puro só na resposta)
    // e atualiza last_seen_at. O WHERE restrito a `active = true` + o check de
    // linhas revogam a corrida com um DELETE concorrente: se o aparelho foi
    // revogado entre a leitura e a escrita, nada é atualizado e cai em
    // `device_revoked`.
    const now = nowIso();
    const newToken = randomDeviceToken();
    const updated = await tx
      .update(userDevices)
      .set({ deviceSecretHash: await argon2.hash(newToken), lastSeenAt: now, updatedAt: now })
      .where(and(eq(userDevices.id, input.deviceId), eq(userDevices.active, true)))
      .returning({ id: userDevices.id });
    if (updated.length === 0) throw Errors.deviceRevoked();

    return { user, newToken };
  });

  const token = jwt.sign({ sub: result.user.id, role: result.user.role }, config.jwtSecret, { expiresIn: "12h" });
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

// ---------------------------------------------------------------------------
// Login com aparelho vinculado (POST /auth/login com deviceId opcional)
// ---------------------------------------------------------------------------

/**
 * Valida o vínculo aparelho→usuário no login por PIN: aparelho conhecido,
 * ativo, não revogado e pertencente ao `userId` que está logando. Sem
 * `deviceId` o login mantém o comportamento atual (PWA/tablet compartilhado).
 * Atualiza `last_seen_at` sem audit (a mesma régua do refresh — seria ruído).
 */
export async function assertDeviceForLogin(userId: string, deviceId: string): Promise<void> {
  const dev = await db.query.userDevices.findFirst({ where: eq(userDevices.id, deviceId) });
  if (!dev) throw Errors.deviceUnknown();
  if (dev.userId !== userId) throw Errors.deviceNotProvisioned();
  if (!dev.active || dev.revokedAt) throw Errors.deviceRevoked();
  const now = nowIso();
  await db
    .update(userDevices)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(and(eq(userDevices.id, deviceId), eq(userDevices.active, true)));
}

// ---------------------------------------------------------------------------
// Gestão de aparelhos (manager)
// ---------------------------------------------------------------------------

export async function listUserDevicesUsecase(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw Errors.notFound("Usuário");
  const rows = await db
    .select()
    .from(userDevices)
    .where(eq(userDevices.userId, userId))
    .orderBy(desc(userDevices.createdAt));
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
}

export async function revokeDeviceUsecase(input: { deviceId: string; actorId: string }) {
  const dev = await db.query.userDevices.findFirst({ where: eq(userDevices.id, input.deviceId) });
  if (!dev) throw Errors.deviceUnknown();
  if (!dev.active || dev.revokedAt) return; // já revogado — idempotente, sem audit duplicado

  await db.transaction(async (tx) => {
    const now = nowIso();
    await tx
      .update(userDevices)
      .set({ active: false, revokedAt: now, updatedAt: now })
      .where(and(eq(userDevices.id, input.deviceId), eq(userDevices.active, true)));
    await logAction(tx, input.actorId, "device_revoked", null, {
      userId: dev.userId,
      deviceId: dev.id,
      label: dev.label,
    });
    await enqueueEvent(tx, ALERTS_MANAGER_ROOM, "device_revoked", {
      deviceId: dev.id,
      userId: dev.userId,
      label: dev.label,
    });
  });
}