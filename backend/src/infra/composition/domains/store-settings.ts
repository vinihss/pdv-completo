/**
 * Composição de domínio — `store-settings` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { deliveryInstances, storeSettingsInstances } from "../default-usecases.js";

export const getStoreSettingsUsecase = storeSettingsInstances.getStoreSettingsUsecase;
export const updateStoreSettingsUsecase = storeSettingsInstances.updateStoreSettingsUsecase;
export const saveStoreLogoUsecase = storeSettingsInstances.saveStoreLogoUsecase;
export const clearStoreLogoUsecase = storeSettingsInstances.clearStoreLogoUsecase;
export const geocodeRestaurantUsecase = deliveryInstances.geocodeRestaurantUsecase;
