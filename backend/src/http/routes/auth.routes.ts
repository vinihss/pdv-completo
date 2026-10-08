import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { users, storeSettings } from "../../infra/db/schema.js";
import { loginUsecase } from "../../application/auth/login.usecase.js";
import { photoUrl } from "../../application/user.usecases.js";
import { loginRateLimit } from "../middlewares/rate-limit.middleware.js";

const loginSchema = z.object({
  userId: z.string(),
  pin: z.string().min(4).max(6),
  // Aparelho provisionado (docs/21 §5.3): presente, o backend valida vínculo
  // ativo; ausente, comportamento atual preservado (PWA/tablet compartilhado).
  deviceId: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance) {
  // Rota pública mínima pra alimentar a tela de seleção de usuário do login
  // (login-prototype.jsx / 02-frontend-spec.md). Não estava na lista de
  // endpoints originais da spec — GET /users é manager-only, mas a tela de
  // login por PIN precisa mostrar pra quem ainda não está autenticado. Expõe
  // só id/name/role/foto de usuários ativos, nunca pinHash. Também respeita os
  // toggles de rollout, escondendo usuários de módulos desligados: "kitchen"
  // quando kitchen_enabled=false e "courier" quando uses_delivery=false —
  // mesmo filtro por configuração que rege o resto do produto.
  app.get("/auth/users", async (_req) => {
    const settings = await db.query.storeSettings.findFirst({
      where: eq(storeSettings.id, "singleton"),
    });
    const rows = await db.query.users.findMany({
      where: eq(users.active, true),
      orderBy: (u, { asc }) => asc(u.name),
    });
    return rows
      .filter((u) => settings?.kitchenEnabled || u.role !== "kitchen")
      .filter((u) => settings?.usesDelivery !== false || u.role !== "courier")
      .map((u) => ({ id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath, "user") }));
  });

  app.post("/auth/login", { preHandler: loginRateLimit }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const result = await loginUsecase(body.userId, body.pin, body.deviceId);
    return reply.code(200).send(result);
  });
}