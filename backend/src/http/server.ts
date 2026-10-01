import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "../config/env.js";
import { runMigrations } from "../infra/db/migrate.js";
import { checkDatabaseHealth } from "../infra/db/client.js";
import { startOutboxDispatcher } from "../infra/realtime/outbox-dispatcher.js";
import { startMaintenanceJobs } from "../infra/maintenance.js";
import { AppError } from "../domain/errors.js";
import { authRoutes } from "./routes/auth.routes.js";
import { orderRoutes } from "./routes/order.routes.js";
import { cashFlowRoutes } from "./routes/cash-flow.routes.js";
import { miscRoutes } from "./routes/misc.routes.js";
import { realtimeRoutes } from "./routes/realtime.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { courierRoutes } from "./routes/courier.routes.js";
import { deliveryManagerRoutes } from "./routes/delivery-manager.routes.js";
import { whatsappWebhookRoutes } from "./routes/whatsapp-webhook.routes.js";
import { ifoodRoutes } from "./routes/ifood.routes.js";
import { whatsappRoutes } from "./routes/whatsapp.routes.js";
import { printRoutes } from "./routes/print.routes.js";
import { alertRoutes } from "./routes/alert.routes.js";
import { startIfoodSync } from "../integrations/ifood/worker.js";
import { getStoreSettingsUsecase } from "../application/store-settings.usecases.js";

// Monta o app Fastify com todas as rotas/plugins, sem escutar. Exportado
// para os testes (vitest) injetarem requests via `app.inject()`.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });

  // ---------- Error handler — envelope padrão da §7.0 ----------
  // Registrado antes dos plugins/rotas: o handler do contexto raiz precisa
  // existir quando os contextos encapsulados são criados pra ser aplicado.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const isZodError =
      err instanceof ZodError ||
      (typeof err === "object" &&
        err !== null &&
        (err as { name?: unknown }).name === "ZodError" &&
        Array.isArray((err as { issues?: unknown }).issues));
    if (isZodError) {
      return reply
        .code(400)
        .send({ error: { code: "validation_failed", message: "Payload inválido.", details: (err as ZodError).issues } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error", message: "Erro interno." } });
  });

  await app.register(cors, {
    // Sem CORS_ORIGIN definido (dev local), libera geral. Em produção,
    // SEMPRE defina CORS_ORIGIN com o domínio real do frontend — ver
    // deploy/README.md. Aceita lista separada por vírgula, porque o app
    // pode ser servido em mais de um endereço (ex.: domínio próprio +
    // hostname antigo do servidor enquanto o DNS não propaga). O trim
    // evita que um espaço depois da vírgula quebre a comparação de origem.
    origin: config.corsOrigin
      ? config.corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
      : true,
  });

  // Preserva o corpo bruto da requisição em req.rawBody, além do JSON já
  // parseado — necessário pra verificar a assinatura X-Hub-Signature-256 do
  // webhook do WhatsApp (§05), sem mudar o parsing normal do resto da API.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(websocketPlugin);

  // ---------- Fotos de produto (§ cadastro) ----------
  // Diretório criado no boot (e no Docker via volume). As imagens são
  // públicas em /uploads/<product_id>.<ext> — nada sensível nelas.
  const uploadsDir = path.resolve(config.uploadsDir);
  fs.mkdirSync(uploadsDir, { recursive: true });

  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 2 MB, 1 arquivo por request
  });

  // Rate limit global — proteção básica de DoS pra API exposta na internet.
  // O login já tem um limite mais apertado próprio (§11); este aqui cobre
  // o resto das rotas.
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // ---------- Health check (§14.4) — sem autenticação ----------
  app.get("/health", async (_req, reply) => {
    const healthy = await checkDatabaseHealth();
    if (healthy) {
      return reply.code(200).send({ status: "ok", database: "connected", tag: process.env.APP_TAG ?? "" });
    }
    return reply.code(503).send({ status: "degraded", database: "disconnected" });
  });

  await app.register(authRoutes);
  await app.register(orderRoutes);
  await app.register(cashFlowRoutes);
  await app.register(miscRoutes);
  await app.register(realtimeRoutes);
  await app.register(publicRoutes);
  await app.register(courierRoutes);
  await app.register(deliveryManagerRoutes);
  await app.register(whatsappWebhookRoutes);
  await app.register(ifoodRoutes);
  await app.register(whatsappRoutes);
  await app.register(printRoutes);
  await app.register(alertRoutes);

  // ---------- Store info pública (§10) — nome exibido no login, sem pix key ----------
  // também expõe flags de operação que a página externa e o próprio login usam
  // para ramificar a UI antes de autenticar (ex.: delivery desligado).
  await app.register(async (publicApp) => {
    publicApp.get("/store-info", async () => {
      const s = await getStoreSettingsUsecase();
      return {
        merchantName: s.merchantName,
        merchantCity: s.merchantCity,
        logoUrl: s.logoUrl,
        brandColor: s.brandColor,
        usesDelivery: s.usesDelivery,
        ifoodIntegrationEnabled: s.ifoodIntegrationEnabled,
        deliveryFee: s.deliveryFee,
        // A tabela de frete e os tempos de preparo: o checkout público usa as
        // mesmas faixas que o balcão para montar o seletor de distância e a
        // previsão de entrega (domain/delivery-eta.ts). Sem isso aqui, a tela
        // teria que adivinhar as faixas e a previsão não bateria com a loja.
        deliveryFeeTiers: s.deliveryFeeTiers,
        deliveryPrepMinutes: s.deliveryPrepMinutes,
        minutesPerKm: s.minutesPerKm,
        enabledPaymentMethods: s.enabledPaymentMethods,
      };
    });
  });

  return app;
}

async function main() {
  // Migrations rodam automaticamente no boot em modo local (§14.5).
  //
  // O `await` é obrigatório. Sem ele a promise rejeitada virava unhandled
  // rejection e o processo subia assim mesmo: o health check respondia 200 e o
  // sintoma aparecia só como 500 em runtime, com o schema pela metade. É
  // exatamente o caso perigoso do deploy — banco "saudável", app quebrado.
  //
  // Falhar aqui é o comportamento correto: o `main().catch` no fim deste
  // arquivo aborta com `exit 1`, e o `restart: unless-stopped` do compose faz o
  // Docker reiniciar o container, deixando o motivo visível em
  // `docker compose logs backend`. Sem o banco pronto, o `pool.connect()`
  // estoura em `connectionTimeoutMillis` (10s) — no compose o backend só sobe
  // depois do `service_healthy` do postgres, então isso não acontece em deploy.
  if (config.deploymentMode === "local") {
    try {
      await runMigrations();
    } catch (err) {
      throw new Error(
        `[boot] migrations falharam — não subo para não servir com schema inconsistente: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  const app = await buildApp();

  const stopDispatcher = startOutboxDispatcher();
  const stopMaintenance = startMaintenanceJobs();
  const ifoodSync = startIfoodSync(); // no-op quando sem IFOOD_SYNC_ENABLED/credenciais

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`PDV backend rodando em modo ${config.deploymentMode} na porta ${config.port}`);

  const shutdown = async () => {
    stopDispatcher();
    stopMaintenance();
    ifoodSync.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// `main()` só roda quando este arquivo é o entrypoint do processo. A suíte de
// testes importa `buildApp` deste módulo (test/helpers.ts) e precisa apenas da
// factory — sem `main()` cada `import` subia um listener real na porta 3000 e
// ligava o dispatcher do outbox, que marcava `published = 1` nos eventos a cada
// 200ms e tornava as asserções que leem `outbox_event` dependentes de timing.
//
// A comparação ignora a extensão porque o mesmo arquivo roda como `.ts` no dev
// (`tsx src/http/server.ts`) e como `.js` no build (`node dist/http/server.js`),
// e o tsx também aceita `server.js` na linha de comando: sem normalizar, esse
// último caso não casaria e o processo sairia em silêncio, sem servidor.
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const stripExt = (p: string) => path.resolve(p).replace(/\.(js|mjs|cjs|ts|mts|cts)$/, "");
  return stripExt(entry) === stripExt(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
