/**
 * `GET /users` (manager): lista completa, ordem alfabética.
 */
import type { UserDependencies } from "../ports/user-dependencies.js";
import { serializeUser } from "../shared/user-helpers.js";

export class ListUsersUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute() {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const rows = await session.users.list();
      return rows.map(serializeUser);
    });
  }
}
