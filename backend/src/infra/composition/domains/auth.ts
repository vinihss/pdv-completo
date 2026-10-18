/**
 * Composição de domínio — `auth` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { identityInstances, loginInstances, userInstances } from "../default-usecases.js";

export const loginUsecase = loginInstances.loginUsecase;
export const listActiveUsersUsecase = userInstances.listActiveUsersUsecase;
export const getOwnProfileUsecase = userInstances.getOwnProfileUsecase;
export const updateOwnProfileUsecase = userInstances.updateOwnProfileUsecase;
export const saveUserPhotoUsecase = userInstances.saveUserPhotoUsecase;
export const clearUserPhotoUsecase = userInstances.clearUserPhotoUsecase;

// Identidade centralizada (docs/26 §4) — etapas conta → empresa → sessão.
export const startSessionUsecase = identityInstances.startSession;
export const changePasswordUsecase = identityInstances.changePassword;
export const selectTenantUsecase = identityInstances.selectTenant;
export const refreshSessionUsecase = identityInstances.refreshSession;
export const logoutSessionUsecase = identityInstances.logoutSession;
export const forgotPasswordUsecase = identityInstances.forgotPassword;
export const resetPasswordUsecase = identityInstances.resetPassword;
