/**
 * Módulo de configurações da loja — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { StoreSettingsDependencies } from "./ports/store-settings-dependencies.js";
import { GetStoreSettingsUseCase } from "./usecases/get-store-settings.usecase.js";
import { UpdateStoreSettingsUseCase } from "./usecases/update-store-settings.usecase.js";
import { SaveStoreLogoUseCase } from "./usecases/save-store-logo.usecase.js";
import { ClearStoreLogoUseCase } from "./usecases/clear-store-logo.usecase.js";

export class StoreSettingsModule {
  public readonly getStoreSettings: GetStoreSettingsUseCase;
  public readonly updateStoreSettings: UpdateStoreSettingsUseCase;
  public readonly saveStoreLogo: SaveStoreLogoUseCase;
  public readonly clearStoreLogo: ClearStoreLogoUseCase;

  constructor(deps: StoreSettingsDependencies) {
    this.getStoreSettings = new GetStoreSettingsUseCase(deps);
    this.updateStoreSettings = new UpdateStoreSettingsUseCase(deps);
    this.saveStoreLogo = new SaveStoreLogoUseCase(deps);
    this.clearStoreLogo = new ClearStoreLogoUseCase(deps);
  }
}
