/**
 * Composição de domínio — `catalog` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { categoryInstances, kitchenGroupInstances, productInstances } from "../default-usecases.js";

export const listProductsUsecase = productInstances.listProductsUsecase;
export const createProductUsecase = productInstances.createProductUsecase;
export const updateProductUsecase = productInstances.updateProductUsecase;
export const setProductActiveUsecase = productInstances.setProductActiveUsecase;
export const saveProductImageUsecase = productInstances.saveProductImageUsecase;
export const clearProductImageUsecase = productInstances.clearProductImageUsecase;
export const listCategoriesUsecase = categoryInstances.listCategoriesUsecase;
export const createCategoryUsecase = categoryInstances.createCategoryUsecase;
export const updateCategoryUsecase = categoryInstances.updateCategoryUsecase;
export const deleteCategoryUsecase = categoryInstances.deleteCategoryUsecase;
export const listKitchenGroupsUsecase = kitchenGroupInstances.listKitchenGroupsUsecase;
export const createKitchenGroupUsecase = kitchenGroupInstances.createKitchenGroupUsecase;
export const updateKitchenGroupUsecase = kitchenGroupInstances.updateKitchenGroupUsecase;
export const deleteKitchenGroupUsecase = kitchenGroupInstances.deleteKitchenGroupUsecase;
