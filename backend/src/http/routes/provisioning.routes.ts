/**
 * Device provisioning (docs/21-device-provisioning.md) — PR 1.
 *
 * Endpoints:
 *   POST   /users/:id/provisioning-key      — gira a chave (manager); devolve
 *                                             {code, qrPayload, expiresAt} 1x
 *   GET    /users/:id/devices               — lista aparelhos (manager)
 *   DELETE /devices/:deviceId               — revoga aparelho (manager)
 *   POST   /public/provisioning/exchange    — público + rate limit: código →
 *                                             {deviceId, deviceToken, user}
 *   POST   /auth/device/refresh             — público + rate limit: device token
 *                                             → JWT novo + token rotacionado
 *
 * Sem `withIdempotency` novo (docs/21 §6): girar chave é
 * idempotente-serializável e o exchange gera registro novo por design.
 * `correlationId` segue opcional no corpo (não usado por estes endpoints).
 *
 * Em vez de `app.addHook("preHandler", authMiddleware)` no plugin (que
 * vazaria para os endpoints públicos), as rotas de gerente listam
 * `[authMiddleware, requireRole("manager")]` no próprio preHandler, na ordem.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { provisioningRateLimit } from "../middlewares/rate-limit.middleware.js";
import {
  generateProvisioningKeyUsecase,
  exchangeProvisioningCodeUsecase,
  refreshDeviceSessionUsecase,
  revokeDeviceUsecase,
  listUserDevicesUsecase,
} from "../../application/provisioning/provisioning.usecases.js";
import {
  sendProvisioningEmailUsecase,
  resendProvisioningEmailUsecase,
} from "../../application/provisioning/provisioning-email.usecase.js";

const keyGenSchema = z.object({
  expiresAt: z.string().optional().nullable(),
});

const exchangeSchema = z.object({
  code: z.string().min(1),
  platform: z.enum(["android", "ios", "web", "desktop"]),
  appProfile: z.enum(["garcon", "entregador", "pdv", "kds"]),
  deviceLabel: z.string().optional().nullable(),
});

const deviceRefreshSchema = z.object({
  deviceId: z.string().min(1),
  deviceToken: z.string().min(1),
});

const emailSchema = z.object({
  downloadLinks: z
    .object({
      android: z.string().optional(),
      ios: z.string().optional(),
      web: z.string().optional(),
    })
    .optional(),
});

export async function provisioningRoutes(app: FastifyInstance) {
  const managerOnly: any[] = [authMiddleware, requireRole("manager")];

  app.post("/users/:id/provisioning-key", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = keyGenSchema.parse(req.body ?? {});
    const result = await generateProvisioningKeyUsecase({
      userId: id,
      createdBy: req.authUser!.sub,
      expiresAt: body.expiresAt,
    });
    return reply.code(201).send(result);
  });

  app.post("/users/:id/provisioning-email", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = emailSchema.parse(req.body ?? {});
    const result = await sendProvisioningEmailUsecase({
      userId: id,
      actorId: req.authUser!.sub,
      downloadLinks: body.downloadLinks,
    });
    return reply.code(200).send(result);
  });

  app.post("/users/:id/provisioning-email/resend", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = emailSchema.parse(req.body ?? {});
    const result = await resendProvisioningEmailUsecase({
      userId: id,
      actorId: req.authUser!.sub,
      downloadLinks: body.downloadLinks,
    });
    return reply.code(200).send(result);
  });

  app.get("/users/:id/devices", { preHandler: managerOnly }, async (req) => {
    const { id } = req.params as { id: string };
    return listUserDevicesUsecase(id);
  });

  app.delete("/devices/:deviceId", { preHandler: managerOnly }, async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string };
    await revokeDeviceUsecase({ deviceId, actorId: req.authUser!.sub });
    return reply.code(204).send();
  });

  // Public: sem authMiddleware — quem se prova é o código da chave (argon2 +
  // rate limit dedicado, docs/21 §11).
  app.post("/public/provisioning/exchange", { preHandler: provisioningRateLimit }, async (req, reply) => {
    const body = exchangeSchema.parse(req.body);
    const result = await exchangeProvisioningCodeUsecase(body);
    return reply.code(201).send(result);
  });

  app.post("/auth/device/refresh", { preHandler: provisioningRateLimit }, async (req) => {
    const body = deviceRefreshSchema.parse(req.body);
    return refreshDeviceSessionUsecase({ ...body, ip: req.ip });
  });
}