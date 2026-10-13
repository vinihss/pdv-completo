/**
 * Rotas de equipe (usuários) — CRUD + PIN + foto.
 *
 * Endpoints:
 *   GET    /users              — listar usuários (manager)
 *   POST   /users              — criar usuário (manager)
 *   PATCH  /users/:id          — atualizar usuário (manager)
 *   PATCH  /users/:id/reset-pin — resetar PIN (manager)
 *   POST   /users/:id/photo    — upload de foto (manager)
 *   DELETE /users/:id/photo    — remover foto (manager)
 *
 * Use cases: `backend/src/application/` (user)
 * Testes: `backend/test/` (team-customers, profiles)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listUsersUsecase,
  createUserUsecase,
  updateUserUsecase,
  resetPinUsecase,
  saveUserPhotoUsecase,
  clearUserPhotoUsecase,
} from "../../infra/composition/domains/user.js";
import { imageExtByMime } from "./image-ext.js";

const userRoleEnum = ["waiter", "kitchen", "manager", "courier", "cashier"] as const;
const userCreateSchema = z.object({
  name: z.string().min(1),
  role: z.enum(userRoleEnum),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
});
const userUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(userRoleEnum).optional(),
  active: z.boolean().optional(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  // PIN manual (4-6 dígitos) — o reset-pin continua disponível para gerar
  // um PIN aleatório.
  pin: z.string().min(4).max(6).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Users ----------
  app.get("/users", { preHandler: requireRole("manager") }, async () => listUsersUsecase());
  app.post("/users", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = userCreateSchema.parse(req.body);
    const created = await createUserUsecase(body);
    return reply.code(201).send(created);
  });
  app.patch("/users/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = userUpdateSchema.parse(req.body);
    // actorId (quem está desativando) entra no audit/evento da cascata de
    // revogação de aparelhos (docs/21 §5.4).
    return updateUserUsecase(id, body, req.authUser!.sub);
  });
  app.patch("/users/:id/reset-pin", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return resetPinUsecase(id);
  });
  // Foto — upload multipart (multipart/form-data, campo "photo")
  app.post("/users/:id/photo", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "photo" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "photo" });
    const buffer = await file.toBuffer();
    return saveUserPhotoUsecase(id, { buffer, ext }, req.authUser!.sub);
  });
  // Foto — remover
  app.delete("/users/:id/photo", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return clearUserPhotoUsecase(id, req.authUser!.sub);
  });
}
