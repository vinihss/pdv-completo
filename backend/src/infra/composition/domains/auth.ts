/**
 * Composição de domínio — `auth` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { loginInstances, userInstances } from "../default-usecases.js";

export const loginUsecase = loginInstances.loginUsecase;
export const listActiveUsersUsecase = userInstances.listActiveUsersUsecase;
export const getOwnProfileUsecase = userInstances.getOwnProfileUsecase;
export const updateOwnProfileUsecase = userInstances.updateOwnProfileUsecase;
export const saveUserPhotoUsecase = userInstances.saveUserPhotoUsecase;
export const clearUserPhotoUsecase = userInstances.clearUserPhotoUsecase;
