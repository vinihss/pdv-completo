/**
 * Composição de domínio — `user` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { userInstances } from "../default-usecases.js";

export const listUsersUsecase = userInstances.listUsersUsecase;
export const createUserUsecase = userInstances.createUserUsecase;
export const updateUserUsecase = userInstances.updateUserUsecase;
export const getOwnProfileUsecase = userInstances.getOwnProfileUsecase;
export const updateOwnProfileUsecase = userInstances.updateOwnProfileUsecase;
export const resetPinUsecase = userInstances.resetPinUsecase;
export const saveUserPhotoUsecase = userInstances.saveUserPhotoUsecase;
export const clearUserPhotoUsecase = userInstances.clearUserPhotoUsecase;
export const listActiveUsersUsecase = userInstances.listActiveUsersUsecase;
