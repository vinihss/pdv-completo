// Use cases de equipe (usuários) — CRUD + PIN + foto + seleção do login.
// Ponto de entrada de COMPATIBILIDADE.
//
// A implementação foi decomposta em um Use Case por operação (Command Pattern
// / Single Use Case Class) em `usecases/*.usecase.ts`, com as dependências em
// `ports/user-dependencies.ts`, os helpers em `shared/user-helpers.ts` e o
// facade `UserModule` em `user.module.ts`.
//
// Este arquivo mantém a factory `createUserUsecases` com os NOMES LEGADOS
// (`listUsersUsecase`, ...) para a composition root
// (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
// Nada muda na assinatura observada de fora. Para uso novo, prefira
// `UserModule` e `.listUsers.execute(...)`.
//
// Módulo puro: nenhuma importação de infra/integrations/config nem de Drizzle.
// Toda persistência sai por `session.users`/`session.userDevices`/
// `session.storeSettings`, o audit e o outbox pela própria sessão (MESMA
// transação) e o storage de foto é um port (`FileStorage`) injetado via deps.
//
// NOTA sobre async: dentro de `deps.uow.run` todo acesso ao `session` é uma
// Promise — sempre `await`. Esquecer o await emitiria o UPDATE depois do
// COMMIT e a escrita se perderia em silêncio. O `throw` continua sendo o
// mecanismo de rollback.
import { UserModule } from "./user.module.js";
import type { UserDependencies } from "./ports/user-dependencies.js";
import type { CreateUserInput } from "./usecases/create-user.usecase.js";
import type { UpdateUserInput } from "./usecases/update-user.usecase.js";
import type { UpdateOwnProfileInput } from "./usecases/update-own-profile.usecase.js";
import type { SaveUserPhotoInput } from "./usecases/save-user-photo.usecase.js";

export { UserModule };
export type { UserDependencies };
export type { UserUsecasesDeps } from "./ports/user-dependencies.js";
export {
  photoUrl,
  type UserRole,
} from "./shared/user-helpers.js";
export { ListUsersUseCase } from "./usecases/list-users.usecase.js";
export {
  CreateUserUseCase,
  type CreateUserInput,
} from "./usecases/create-user.usecase.js";
export {
  UpdateUserUseCase,
  type UpdateUserInput,
} from "./usecases/update-user.usecase.js";
export { GetOwnProfileUseCase } from "./usecases/get-own-profile.usecase.js";
export {
  UpdateOwnProfileUseCase,
  type UpdateOwnProfileInput,
} from "./usecases/update-own-profile.usecase.js";
export { ResetPinUseCase } from "./usecases/reset-pin.usecase.js";
export { ListActiveUsersUseCase } from "./usecases/list-active-users.usecase.js";
export {
  SaveUserPhotoUseCase,
  type SaveUserPhotoInput,
} from "./usecases/save-user-photo.usecase.js";
export { ClearUserPhotoUseCase } from "./usecases/clear-user-photo.usecase.js";

export function createUserUsecases(deps: UserDependencies) {
  const module = new UserModule(deps);
  return {
    /** `GET /users` (manager): lista completa, ordem alfabética. */
    listUsersUsecase: () => module.listUsers.execute(),
    /** `POST /users` (manager): cria com PIN aleatório (retornado uma única vez). */
    createUserUsecase: (input: CreateUserInput) => module.createUser.execute(input),
    /** `PATCH /users/:id` (manager): update parcial + cascata de desativação. */
    updateUserUsecase: (id: string, input: UpdateUserInput, actorId?: string) =>
      module.updateUser.execute(id, input, actorId),
    /** `GET /auth/me`: leitura do próprio perfil. */
    getOwnProfileUsecase: (id: string) => module.getOwnProfile.execute(id),
    /** `PATCH /auth/me`: self-service de dados de contato. */
    updateOwnProfileUsecase: (id: string, input: UpdateOwnProfileInput) =>
      module.updateOwnProfile.execute(id, input),
    /** `PATCH /users/:id/reset-pin` (manager): PIN aleatório, retornado uma vez. */
    resetPinUsecase: (id: string) => module.resetPin.execute(id),
    /** `GET /auth/users` (público, tela de seleção do login). */
    listActiveUsersUsecase: () => module.listActiveUsers.execute(),
    /** `POST /users/:id/photo` e `/auth/me/photo`. */
    saveUserPhotoUsecase: (id: string, input: SaveUserPhotoInput, actorId: string) =>
      module.saveUserPhoto.execute(id, input, actorId),
    /** `DELETE /users/:id/photo` e `/auth/me/photo`. */
    clearUserPhotoUsecase: (id: string, actorId: string) => module.clearUserPhoto.execute(id, actorId),
  };
}

export type UserUsecases = ReturnType<typeof createUserUsecases>;
