/**
 * Ponto de entrada do módulo de identidade centralizada (docs/26 §4).
 *
 * Mesmo padrão dos outros módulos migrados: um Use Case por operação, com as
 * dependências injetadas; esta factory monta o conjunto e é o que a composition
 * root (`infra/composition/default-usecases.ts`) instancia e re-exporta para as
 * rotas. Módulo PURO — nenhuma importação de infra/config/Drizzle.
 */
import type { IdentityDependencies } from "./ports/identity-dependencies.js";
import { createStartSessionUsecase } from "./usecases/start-session.usecase.js";
import { createChangePasswordUsecase } from "./usecases/change-password.usecase.js";
import { createSelectTenantUsecase } from "./usecases/select-tenant.usecase.js";
import { createRefreshSessionUsecase } from "./usecases/refresh-session.usecase.js";
import { createForgotPasswordUsecase } from "./usecases/forgot-password.usecase.js";
import { createResetPasswordUsecase } from "./usecases/reset-password.usecase.js";

export function createIdentityUsecases(deps: IdentityDependencies) {
  const { startSession } = createStartSessionUsecase(deps);
  const { changePassword } = createChangePasswordUsecase(deps);
  const { selectTenant } = createSelectTenantUsecase(deps);
  const { refreshSession, logoutSession } = createRefreshSessionUsecase(deps);
  const { forgotPassword } = createForgotPasswordUsecase(deps);
  const { resetPassword } = createResetPasswordUsecase(deps);

  return {
    startSession,
    changePassword,
    selectTenant,
    refreshSession,
    logoutSession,
    forgotPassword,
    resetPassword,
  };
}

export type IdentityUsecases = ReturnType<typeof createIdentityUsecases>;
