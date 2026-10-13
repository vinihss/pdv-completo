/**
 * Port de provisionamento de aparelhos (`provisioning_key`/`user_device` —
 * docs/21).
 *
 * Contrato CONGELADO: os use cases falam com estas interfaces; o adapter
 * Postgres (`src/infra/db/repositories/provisioning.repository.ts`) traduz
 * para Drizzle/schema.
 */
import type { Id } from "./shared.js";

/**
 * ADIÇÃO (device provisioning): chave de provisionamento (`provisioning_key`).
 * O SEGREDO existe em texto puro só na resposta da geração; no banco vive o
 * hash argon2 (`codeHash`) e, para exibição, o sufixo `codeHint`.
 */
export interface ProvisioningKeyRecord {
  id: Id;
  userId: Id;
  codeHash: string;
  codeHint: string;
  createdBy: Id | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningKeyRepository {
  /** Revoga a chave ativa do usuário (rotação): `WHERE user_id = ? AND revoked_at IS NULL`. */
  revokeActive(userId: Id, at: string): Promise<void>;
  /**
   * Cria a chave. O `ON CONFLICT DO NOTHING` do índice único parcial
   * `uq_provisioning_key_active` cobre a corrida de dois gerentes: o perdedor
   * recebe `null` (sem código) em vez de estourar 500.
   */
  create(input: {
    userId: Id;
    codeHash: string;
    codeHint: string;
    createdBy: Id | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<ProvisioningKeyRecord | null>;
  /**
   * Chaves "vivas" para o match por verificação: não revogadas (ou revogadas
   * DEPOIS de `cutoff`) e não expiradas (ou expiradas depois de `cutoff`). O
   * `cutoff` é a janela de graça para responder `revoked` em vez de `invalid`.
   */
  listCandidates(cutoff: string): Promise<ProvisioningKeyRecord[]>;
}

/**
 * ADIÇÃO (device provisioning): aparelho provisionado (`user_device`).
 * `active`/`revokedAt` são o ciclo de vida; `deviceSecretHash` é argon2 do
 * device token (texto puro só na resposta do exchange/refresh).
 */
export interface UserDeviceRecord {
  id: Id;
  userId: Id;
  provisioningKeyId: Id | null;
  label: string | null;
  platform: string;
  appProfile: string;
  deviceSecretHash: string;
  active: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserDeviceRepository {
  /** Revoga TODOS os aparelhos ativos do usuário (cascata da desativação); devolve quantos. */
  revokeAll(userId: Id, at: string): Promise<number>;
  create(input: {
    userId: Id;
    provisioningKeyId: Id | null;
    label: string | null;
    platform: string;
    appProfile: string;
    deviceSecretHash: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<UserDeviceRecord>;
  findById(id: Id): Promise<UserDeviceRecord | null>;
  /**
   * Rotaciona o device token com LOCK OTIMISTA de ciclo de vida: `WHERE id = ?
   * AND active = true`. `false` = nenhuma linha (aparelho revogado em corrida).
   */
  rotateToken(id: Id, patch: { deviceSecretHash: string; lastSeenAt: string; updatedAt: string }): Promise<boolean>;
  /** Atualiza `last_seen_at`/`updated_at` só se o aparelho segue ativo (login com deviceId). */
  touchLastSeen(id: Id, at: string): Promise<void>;
  /** Aparelhos do usuário, mais recentes primeiro (`created_at DESC`). */
  listByUser(userId: Id): Promise<UserDeviceRecord[]>;
  /** Revoga um aparelho (`active = false` + `revoked_at`) — `WHERE active = true`. */
  revoke(id: Id, at: string): Promise<void>;
}
