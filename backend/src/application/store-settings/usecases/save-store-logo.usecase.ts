/**
 * `POST /store-settings/logo` — upload do logo (identidade da marca).
 *
 * O nome é FIXO (`logo.<ext>`) — era o que fazia a loja B sobrescrever o logo
 * da loja A num diretório único (doc 15 §5.2). Quem resolve agora é o layout:
 * `<uploads>/<schema>/logo/logo.<ext>`, um diretório por tenant. O
 * `logo_path` continua significando "o nome do arquivo do logo".
 */
import { Errors } from "../../../domain/errors.js";
import type { StoreSettingsDependencies } from "../ports/store-settings-dependencies.js";
import { isSafeFilename, serializeStoreSettings, storageFilename } from "../shared/store-settings-helpers.js";

export type SaveStoreLogoInput = {
  buffer: Buffer;
  ext: string;
};

export class SaveStoreLogoUseCase {
  constructor(private readonly deps: StoreSettingsDependencies) {}

  async execute(input: SaveStoreLogoInput, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const settings = await session.storeSettings.findSingleton();
      if (!settings) throw Errors.notFound("Configuração da loja");

      const filename = `logo.${input.ext}`;
      if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "logo" });
      await this.deps.storage.put("logo", filename, input.buffer);

      // Remove o logo antigo quando a extensão muda (logo.jpg → logo.png)
      const previous = storageFilename(settings.logoPath);
      if (previous && previous !== filename) await this.deps.storage.remove("logo", previous);

      const updated = await session.storeSettings.setLogoPath(filename);
      await session.audit.record({
        actorId,
        action: "store_logo_changed",
        orderId: null,
        details: { logoPath: filename },
      });
      await this.deps.cache.invalidatePrefix("store-settings");
      return serializeStoreSettings(updated);
    });
  }
}
