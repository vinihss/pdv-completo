/**
 * `DELETE /store-settings/logo` — remove o logo do disco e limpa `logo_path`.
 */
import { Errors } from "../../../domain/errors.js";
import type { StoreSettingsDependencies } from "../ports/store-settings-dependencies.js";
import { serializeStoreSettings, storageFilename } from "../shared/store-settings-helpers.js";

export class ClearStoreLogoUseCase {
  constructor(private readonly deps: StoreSettingsDependencies) {}

  async execute(actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const settings = await session.storeSettings.findSingleton();
      if (!settings) throw Errors.notFound("Configuração da loja");
      if (!settings.logoPath) return serializeStoreSettings(settings);

      const previous = storageFilename(settings.logoPath);
      if (previous) await this.deps.storage.remove("logo", previous);

      const updated = await session.storeSettings.setLogoPath(null);
      await session.audit.record({
        actorId,
        action: "store_logo_removed",
        orderId: null,
      });
      await this.deps.cache.invalidatePrefix("store-settings");
      return serializeStoreSettings(updated);
    });
  }
}
