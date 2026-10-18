import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { accountAuthMiddleware, authMiddleware } from "../middlewares/auth.middleware.js";
import { forgotPasswordRateLimit, loginRateLimit } from "../middlewares/rate-limit.middleware.js";
import { imageExtByMime } from "./image-ext.js";
import { requestOrigin } from "./request-origin.js";
// Acesso a dados via composition root (a rota não toca em Drizzle/schema/client):
// `login`, a seleção pública de usuários e o self-service de perfil/foto.
import {
  loginUsecase,
  listActiveUsersUsecase,
  getOwnProfileUsecase,
  updateOwnProfileUsecase,
  saveUserPhotoUsecase,
  clearUserPhotoUsecase,
  startSessionUsecase,
  changePasswordUsecase,
  selectTenantUsecase,
  refreshSessionUsecase,
  logoutSessionUsecase,
  forgotPasswordUsecase,
  resetPasswordUsecase,
} from "../../infra/composition/domains/auth.js";

const loginSchema = z.object({
  userId: z.string(),
  pin: z.string().min(4).max(6),
  // Aparelho provisionado (docs/21 §5.3): presente, o backend valida vínculo
  // ativo; ausente, comportamento atual preservado (PWA/tablet compartilhado).
  deviceId: z.string().optional(),
});

// ---------- Identidade centralizada (docs/26 §4) ----------
//
// `min(1)` em senha/token de propósito: a POLÍTICA de senha (8..128) é do use
// case, que responde `password_too_short` com mensagem amigável — se o Zod
// cortasse antes, a tela de troca de senha mostraria só "Payload inválido."
const sessionSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});
const selectTenantSchema = z.object({ slug: z.string().min(1) });
const refreshTokenSchema = z.object({ refreshToken: z.string().min(1) });
const logoutSchema = z.object({ refreshToken: z.string().min(1).optional() });
const changePasswordSchema = z.object({ newPassword: z.string().min(1) });
const forgotPasswordSchema = z.object({ email: z.string().min(1) });
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(1),
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
  // mesmo filtro por configuração que rege o resto do produto. O escopo de
  // tenant é garantido pelo hook global de `server.ts` (ensureTenantScope).
  app.get("/auth/users", async () => listActiveUsersUsecase());

  app.post("/auth/login", { preHandler: loginRateLimit }, async (req) => {
    const body = loginSchema.parse(req.body);
    return loginUsecase(body.userId, body.pin, body.deviceId);
  });

  // ---------- Identidade centralizada: conta global (docs/26 §4) ----------
  //
  // Etapa 1 do login novo: email + senha → `accountToken` (10min) + empresas
  // vinculadas. 401 é SEMPRE a mesma credencial genérica (senha errada, email
  // desconhecido, conta suspensa) e o rate limit é o mesmo do login por PIN.
  app.post("/auth/session", { preHandler: loginRateLimit }, async (req) => {
    const body = sessionSchema.parse(req.body);
    return startSessionUsecase(body);
  });

  // Troca (normalmente obrigatória) da senha da conta. Bearer `accountToken`.
  app.post("/auth/password/change", { preHandler: accountAuthMiddleware }, async (req) => {
    const body = changePasswordSchema.parse(req.body);
    return changePasswordUsecase({ accountId: req.authAccount!.id, newPassword: body.newPassword });
  });

  // Pedido do link de recuperação. Sempre 202 quando o SMTP está configurado
  // (não enumera contas); sem SMTP, 503 `email_not_configured`. A origem do
  // link é montada AQUI a partir do request (a application não lê `req`).
  app.post("/auth/password/forgot", { preHandler: forgotPasswordRateLimit }, async (req, reply) => {
    const body = forgotPasswordSchema.parse(req.body);
    await forgotPasswordUsecase({ email: body.email, origin: requestOrigin(req) });
    return reply.code(202).send({ ok: true });
  });

  // Troca de senha pelo token do email (rota PÚBLICA: o token é a autorização).
  app.post("/auth/password/reset", async (req) => {
    const body = resetPasswordSchema.parse(req.body);
    return resetPasswordUsecase(body);
  });

  // Etapa 2: troca o `accountToken` pela sessão de tenant da empresa escolhida.
  app.post("/auth/select-tenant", { preHandler: accountAuthMiddleware }, async (req) => {
    const body = selectTenantSchema.parse(req.body);
    return selectTenantUsecase({ accountId: req.authAccount!.id, slug: body.slug });
  });

  // Rotação do refresh por dispositivo (reuso revoga a família) e logout
  // idempotente — nenhuma das duas usa Bearer: o refresh token É a credencial.
  app.post("/auth/refresh", async (req) => {
    const body = refreshTokenSchema.parse(req.body);
    return refreshSessionUsecase(body);
  });

  app.post("/auth/logout", async (req) => {
    const body = logoutSchema.parse(req.body ?? {});
    // Sem token não há o que revogar: o contrato é 200 sempre.
    if (!body.refreshToken) return { ok: true };
    return logoutSessionUsecase({ refreshToken: body.refreshToken });
  });

  // GET primeiro: a tela de perfil lê o perfil fresco ao abrir — o login
  // não traz phone/email e iniciar o formulário com a sessão deixaria os
  // campos vazios (um salvar apagaria valores existentes no banco).
  app.get("/auth/me", { preHandler: authMiddleware }, async (req) => getOwnProfileUsecase(req.authUser!.sub));

  app.patch("/auth/me", { preHandler: authMiddleware }, async (req) => {
    const body = meUpdateSchema.parse(req.body);
    return updateOwnProfileUsecase(req.authUser!.sub, body);
  });

  // Foto do PRÓPRIO usuário logado — o par self-service das rotas
  // `POST`/`DELETE /users/:id/photo` (manager-only, em user.routes.ts), para
  // a tela de perfil não depender de gerente para trocar a imagem do próprio
  // avatar. Mesmo desenho do PATCH acima: `authMiddleware` por rota e o id
  // vem SEMPRE do token (`req.authUser!.sub`), nunca de params/body — não há
  // como um usuário mexer na foto de outro.
  //
  // `@fastify/multipart` é registrado na RAIZ do app (server.ts), antes do
  // `authRoutes`, então `req.file()` já funciona aqui sem registro extra.
  // MIME validado com o MESMO `imageExtByMime` da rota manager (fonte única,
  // em image-ext.ts) e a gravação é o MESMO `saveUserPhotoUsecase`
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
    clearUserPhotoUsecase(req.authUser!.sub, req.authUser!.sub),
  );
}
