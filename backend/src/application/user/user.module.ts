/**
 * Módulo de equipe (usuários) — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { UserDependencies } from "./ports/user-dependencies.js";
import { ListUsersUseCase } from "./usecases/list-users.usecase.js";
import { CreateUserUseCase } from "./usecases/create-user.usecase.js";
import { UpdateUserUseCase } from "./usecases/update-user.usecase.js";
import { GetOwnProfileUseCase } from "./usecases/get-own-profile.usecase.js";
import { UpdateOwnProfileUseCase } from "./usecases/update-own-profile.usecase.js";
import { ResetPinUseCase } from "./usecases/reset-pin.usecase.js";
import { ListActiveUsersUseCase } from "./usecases/list-active-users.usecase.js";
import { SaveUserPhotoUseCase } from "./usecases/save-user-photo.usecase.js";
import { ClearUserPhotoUseCase } from "./usecases/clear-user-photo.usecase.js";

export class UserModule {
  public readonly listUsers: ListUsersUseCase;
  public readonly createUser: CreateUserUseCase;
  public readonly updateUser: UpdateUserUseCase;
  public readonly getOwnProfile: GetOwnProfileUseCase;
  public readonly updateOwnProfile: UpdateOwnProfileUseCase;
  public readonly resetPin: ResetPinUseCase;
  public readonly listActiveUsers: ListActiveUsersUseCase;
  public readonly saveUserPhoto: SaveUserPhotoUseCase;
  public readonly clearUserPhoto: ClearUserPhotoUseCase;

  constructor(deps: UserDependencies) {
    this.listUsers = new ListUsersUseCase(deps);
    this.createUser = new CreateUserUseCase(deps);
    this.updateUser = new UpdateUserUseCase(deps);
    this.getOwnProfile = new GetOwnProfileUseCase(deps);
    this.updateOwnProfile = new UpdateOwnProfileUseCase(deps);
    this.resetPin = new ResetPinUseCase(deps);
    this.listActiveUsers = new ListActiveUsersUseCase(deps);
    this.saveUserPhoto = new SaveUserPhotoUseCase(deps);
    this.clearUserPhoto = new ClearUserPhotoUseCase(deps);
  }
}
