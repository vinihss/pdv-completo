/**
 * Leitura do próprio perfil (GET /auth/me): o mesmo `serialize` do PATCH,
 * para a tela de perfil abrir com telefone/e-mail reais — o login devolve só
 * `{ id, name, role, photoPath }` e inicializar o formulário com a sessão
 * deixaria os campos vazios (um salvar apagaria o que já está no banco).
 * 404 quando o usuário do token não existe mais (mesma régua do PATCH).
 */
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import { serializeUser } from "../shared/user-helpers.js";

export class GetOwnProfileUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");
      return serializeUser(existing);
    });
  }
}
