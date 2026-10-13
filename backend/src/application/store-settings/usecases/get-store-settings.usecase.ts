/**
 * `GET /store-settings` — lê o singleton e guarda em cache por schema com a
 * chave fixa `store-settings` (TTL 300s — cache particionado, uma loja nunca
 * serve a marca de outra).
 */
import { Errors } from "../../../domain/errors.js";
import type { StoreSettingsDependencies } from "../ports/store-settings-dependencies.js";
import { serializeStoreSettings } from "../shared/store-settings-helpers.js";

export class GetStoreSettingsUseCase {
  constructor(private readonly deps: StoreSettingsDependencies) {}

  async execute() {
    const key = "store-settings";
    const cached = await this.deps.cache.get<ReturnType<typeof serializeStoreSettings>>(key);
    if (cached) return cached;

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const s = await session.storeSettings.findSingleton();
      if (!s) throw Errors.notFound("Configuração da loja");
      const result = serializeStoreSettings(s);
      await this.deps.cache.set(key, result, { ttl: 300 });
      return result;
    });
  }
}
