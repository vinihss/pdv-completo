/**
 * Dependências compartilhadas do módulo de configurações da loja.
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O `tenant`
 * é resolvido a cada chamada (ALS/request corrente) e nunca memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { TenantCache, FileStorage, GeocodingService } from "../../ports/effects.js";

export interface StoreSettingsDependencies {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Cache por schema — invalida a chave `store-settings` após o commit. */
  cache: TenantCache;
  /** Upload/remoção do logo em disco. */
  storage: FileStorage;
  /** Forward geocoding do endereço do restaurante (seam trocável). */
  geocoding: GeocodingService;
}

/** Nome legado da interface de dependências (o módulo passou a chamá-la `StoreSettingsDependencies`). */
export type StoreSettingsUsecasesDeps = StoreSettingsDependencies;
