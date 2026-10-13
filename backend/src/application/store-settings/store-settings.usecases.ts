/**
 * Configurações da loja — ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class) em `usecases/*.usecase.ts`, com as dependências em
 * `ports/store-settings-dependencies.ts`, os helpers em
 * `shared/store-settings-helpers.ts` e o facade `StoreSettingsModule` em
 * `store-settings.module.ts`.
 *
 * Este arquivo mantém a factory `createStoreSettingsUsecases` com os NOMES
 * LEGADOS (`getStoreSettingsUsecase`, ...) para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `StoreSettingsModule` e `.getStoreSettings.execute(...)`.
 *
 * Módulo puro: nenhuma importação de infra/integrations/Drizzle. Persistência
 * via `session.storeSettings` na janela `uow.run` (leitura do singleton +
 * escrita na MESMA transação), audit via `session.audit`, cache via port
 * `TenantCache` e arquivos via port `FileStorage`; o forward geocoding entra
 * pelo effect port `GeocodingService` (seam trocável, mesmo do contexto
 * delivery).
 */
import { StoreSettingsModule } from "./store-settings.module.js";
import type { StoreSettingsDependencies } from "./ports/store-settings-dependencies.js";
import type { UpdateStoreSettingsInput } from "./usecases/update-store-settings.usecase.js";
import type { SaveStoreLogoInput } from "./usecases/save-store-logo.usecase.js";

export { StoreSettingsModule };
export type { StoreSettingsDependencies };
export type { StoreSettingsUsecasesDeps } from "./ports/store-settings-dependencies.js";
export { GetStoreSettingsUseCase } from "./usecases/get-store-settings.usecase.js";
export {
  UpdateStoreSettingsUseCase,
  type UpdateStoreSettingsInput,
} from "./usecases/update-store-settings.usecase.js";
export {
  SaveStoreLogoUseCase,
  type SaveStoreLogoInput,
} from "./usecases/save-store-logo.usecase.js";
export { ClearStoreLogoUseCase } from "./usecases/clear-store-logo.usecase.js";

export function createStoreSettingsUsecases(deps: StoreSettingsDependencies) {
  const module = new StoreSettingsModule(deps);
  return {
    getStoreSettingsUsecase: () => module.getStoreSettings.execute(),
    updateStoreSettingsUsecase: (input: UpdateStoreSettingsInput) =>
      module.updateStoreSettings.execute(input),
    saveStoreLogoUsecase: (input: SaveStoreLogoInput, actorId: string) =>
      module.saveStoreLogo.execute(input, actorId),
    clearStoreLogoUsecase: (actorId: string) => module.clearStoreLogo.execute(actorId),
  };
}

export type StoreSettingsUsecases = ReturnType<typeof createStoreSettingsUsecases>;
