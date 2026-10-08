import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { users, storeSettings } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { loginUsecase } from "../../application/auth/login.usecase.js";
import {
  photoUrl,
  getOwnProfileUsecase,
  updateOwnProfileUsecase,
  saveUserPhotoUsecase,
  clearUserPhotoUsecase,
} from "../../application/user.usecases.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { loginRateLimit } from "../middlewares/rate-limit.middleware.js";
import { imageExtByMime } from "./misc.routes.js";

const loginSchema = z.object({
  userId: z.string(),
  pin: z.string().min(4).max(6),
  // Aparelho provisionado (docs/21 §5.3): presente, o backend valida vínculo
  // ativo; ausente, comportamento atual preservado (PWA/tablet compartilhado).
  deviceId: z.string().optional(),
});

// Self-service de perfil: o usuário logado edita os PRÓPRIOS dados de
// contato. `strictObject` de propósito — campos fora do contrato (role, pin,
// active, photoPath…) são REJEITADOS pelo schema, não silenciosamente
// descartados: descartar daria ao cliente a sensação de ter trocado de
// papel/PIN quando nada mudou. Os campos de poder continuam sendo exclusivos
// de `PATCH /users/:id` (manager), que não muda.
const meUpdateSchema = z.strictObject({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
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
    // Passa o host para o loginUsecase resolver o tenant manualmente se o ALS estiver vazio
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    const result = await loginUsecase(body.userId, body.pin, body.deviceId, host);
    return reply.code(200).send(result);
  });

  // Perfil do próprio usuário logado. `authMiddleware` por rota (não por
  // plugin) porque os endpoints públicos do arquivo (GET /auth/users e
  // POST /auth/login) continuam sendo. O id vem SEMPRE do token
  // (`req.authUser!.sub`), nunca do body — não há como um usuário ler ou
  // editar o perfil de outro. Qualquer papel autenticado entra (sem
  // `requireRole`): é exatamente a lacuna que PATCH /users/:id (manager-only)
  // deixava aberta para garçom/cozinha/caixa/entregador.
  //
  // GET primeiro: a tela de perfil lê o perfil fresco ao abrir — o login
  // não traz phone/email e iniciar o formulário com a sessão deixaria os
  // campos vazios (um salvar apagaria valores existentes no banco).
  app.get("/auth/me", { preHandler: authMiddleware }, async (req) => getOwnProfileUsecase(req.authUser!.sub));

  app.patch("/auth/me", { preHandler: authMiddleware }, async (req) => {
    const body = meUpdateSchema.parse(req.body);
    return updateOwnProfileUsecase(req.authUser!.sub, body);
  });

  // Foto do PRÓPRIO usuário logado — o par self-service das rotas
  // `POST`/`DELETE /users/:id/photo` (manager-only, em misc.routes.ts), para
  // a tela de perfil não depender de gerente para trocar a imagem do próprio
  // avatar. Mesmo desenho do PATCH acima: `authMiddleware` por rota e o id
  // vem SEMPRE do token (`req.authUser!.sub`), nunca de params/body — não há
  // como um usuário mexer na foto de outro.
  //
  // `@fastify/multipart` é registrado na RAIZ do app (server.ts), antes do
  // `authRoutes`, então `req.file()` já funciona aqui sem registro extra.
  // MIME validado com o MESMO `imageExtByMime` da rota manager (fonte única,
  // exportada de misc.routes.ts) e a gravação é o MESMO `saveUserPhotoUsecase`
  // — nada de lógica de arquivo duplicada. Resposta = mesmo `serialize` do
  // PATCH (inclui `photoPath`); 404 quando o usuário do token não existe mais
  // (mesma régua dos usecases de perfil).
  app.post("/auth/me/photo", { preHandler: authMiddleware }, async (req) => {
    // Sem multipart (ou multipart sem arquivo) o `req.file()` devolveria
    // undefined / lançaria erro de plugin → 500 fora do catálogo. "Sem foto"
    // é erro de validação como na rota manager.
    if (!req.isMultipart()) throw Errors.validationFailed({ field: "photo" });
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "photo" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "photo" });
    const buffer = await file.toBuffer();
    return saveUserPhotoUsecase(req.authUser!.sub, { buffer, ext }, req.authUser!.sub);
  });

  app.delete("/auth/me/photo", { preHandler: authMiddleware }, async (req) =>
    clearUserPhotoUsecase(req.authUser!.sub, req.authUser!.sub)
  );
}
