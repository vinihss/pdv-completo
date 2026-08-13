import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "../config/env.js";
import { runMigrations } from "../infra/db/migrate.js";
import { rawSqlite } from "../infra/db/client.js";
import { startOutboxDispatcher } from "../infra/realtime/outbox-dispatcher.js";
import { AppError } from "../domain/errors.js";
import { authRoutes } from "./routes/auth.routes.js";
import { orderRoutes } from "./routes/order.routes.js";
import { miscRoutes } from "./routes/misc.routes.js";
import { realtimeRoutes } from "./routes/realtime.routes.js";
import { getStoreSettingsUsecase } from "../application/store-settings.usecases.js";

async function main() {
  // Migrations rodam automaticamente no boot em modo local (§14.5)
  if (config.deploymentMode === "local") {
    runMigrations();
  }

  // trustProxy: atrás do Caddy/nginx, req.ip deve ser o IP real do client
  // (via X-Forwarded-For), senão todos os clients compartilham o IP do proxy
  // e o rate limit vira global. "1" = confiar em apenas 1 hop de proxy.
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: 1 });

  await app.register(cors, {
    // Sem CORS_ORIGIN definido (dev local), libera geral. Em produção,
    // SEMPRE defina CORS_ORIGIN com o domínio real do frontend — ver
    // deploy/README.md.
    origin: config.corsOrigin ? config.corsOrigin.split(",") : true,
  });
  await app.register(websocketPlugin);

  // Rate limit global — proteção básica de DoS pra API exposta na internet.
  // O login já tem um limite mais apertado próprio (§11); este aqui cobre
  // o resto das rotas.
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // ---------- Health check (§14.4) — sem autenticação ----------
  app.get("/health", async (_req, reply) => {
    try {
      rawSqlite.prepare("SELECT 1").get();
      return reply.code(200).send({ status: "ok", database: "connected" });
    } catch {
      return reply.code(503).send({ status: "degraded", database: "disconnected" });
    }
  });

  await app.register(authRoutes);
  await app.register(orderRoutes);
  await app.register(miscRoutes);
  await app.register(realtimeRoutes);

  // ---------- Store info pública (§10) — nome exibido no login, sem pix key ----------
  await app.register(async (publicApp) => {
    publicApp.get("/store-info", async () => {
      const s = await getStoreSettingsUsecase();
      return { merchantName: s.merchantName, merchantCity: s.merchantCity };
    });
  });

  // ---------- Error handler — envelope padrão da §7.0 ----------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: "validation_failed", message: "Payload inválido.", details: err.issues } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error", message: "Erro interno." } });
  });

  const stopDispatcher = startOutboxDispatcher();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`PDV backend rodando em modo ${config.deploymentMode} na porta ${config.port}`);

  const shutdown = async () => {
    stopDispatcher();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
