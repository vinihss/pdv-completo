import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyMultipart from "@fastify/multipart";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "../config/env.js";
import { runMigrations } from "../infra/db/migrate.js";
import { runRegistryMigrations } from "../infra/db/registry-migrate.js";
import { checkDatabaseHealth } from "../infra/db/client.js";
import { startOutboxDispatcher } from "../infra/realtime/outbox-dispatcher.js";
import { startMaintenanceJobs } from "../infra/maintenance.js";
import { initStorage } from "../infra/storage/index.js";
import { AppError } from "../domain/errors.js";
import { authRoutes } from "./routes/auth.routes.js";
import { orderRoutes } from "./routes/order.routes.js";
import { cashFlowRoutes } from "./routes/cash-flow.routes.js";
import { miscRoutes } from "./routes/misc.routes.js";
import { realtimeRoutes } from "./routes/realtime.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { tenantRoutes } from "./routes/tenant.routes.js";
import { courierRoutes } from "./routes/courier.routes.js";
import { deliveryManagerRoutes } from "./routes/delivery-manager.routes.js";

import { ifoodRoutes } from "./routes/ifood.routes.js";
import { paymentRoutes } from "./routes/payment.routes.js";
import { pagarmeWebhookRoutes } from "./routes/pagarme-webhook.routes.js";
import { pagarmeInternalRoutes } from "./routes/pagarme-internal.routes.js";

import { printRoutes } from "./routes/print.routes.js";
import { alertRoutes } from "./routes/alert.routes.js";
import { provisioningRoutes } from "./routes/provisioning.routes.js";
import { uploadsRoutes } from "./routes/uploads.routes.js";
import { startIfoodSync } from "../integrations/ifood/worker.js";
import { startPagarmeWorkers } from "../integrations/pagarme/worker.js";
import { getStoreSettingsUsecase } from "../application/store-settings.usecases.js";
import { listActiveTenants } from "../infra/tenant/registry.js";
import { resolveTenantSchema } from "../infra/storage/index.js";
import { enterTenantScope, exitTenantScope } from "../infra/db/tenant-context.js";
import { resolveTenant } from "../application/tenant/resolve-tenant.usecase.js";

// Monta o app Fastify com todas as rotas/plugins, sem escutar. Exportado
// para os testes (vitest) injetarem requests via `app.inject()`.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });

  const NO_TENANT_RESOLVE = new Set(["/health", "/internal/caddy-on-demand-tls", "/public/tenants/resolve"]);
  app.addHook("onRequest", async (req) => {
    if (NO_TENANT_RESOLVE.has(req.url.split("?")[0])) return;
    const rawHost =
      (req.query as Record<string, unknown> | undefined)?.host ??
      req.headers["x-tenant-host"] ??
      req.hostname;
    const tenant = await resolveTenant(typeof rawHost === "string" ? rawHost : undefined);
    enterTenantScope({ schemaName: tenant.schemaName, isDefault: tenant.isDefault });
  });
  // Limpa o escopo ao fim do request: sem isto, o ALS guardaria a loja
  // do request anterior para o código que roda depois (inclusive testes
  // que injetam vários requests no mesmo contexto async).
  app.addHook("onResponse", async () => {
    exitTenantScope();
  });

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

  // ---------- Fotos (produto, logo, cliente, equipe) ----------
  // A raiz do volume nasce no boot (e no Docker via volume). Quem serve é a
  // rota explícita `GET /uploads/:kind/:filename` (uploads.routes.ts): ela
  // resolve o tenant por operação e lê de `<uploads>/<schema>/<kind>/`, o que
  // dá fronteira de isolamento ao storage — o `@fastify/static` (diretório
  // flat, escopo raiz, sem auth) não dava. As imagens seguem públicas: não
  // têm nada sensível nelas.
  initStorage();

  await app.register(uploadsRoutes);

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

  // ---------- Permissão para on-demand TLS do Caddy (§wildcard) ----------
  // O Caddy consulta GET /internal/caddy-on-demand-tls?domain=<host> antes
  // de emitir um certificado sob demanda; 2xx libera, demais bloqueia.
  // Só subdomínios de UMA label de *.labolabe.tech passam.
  app.get("/internal/caddy-on-demand-tls", async (req, reply) => {
    const domain = String((req.query as Record<string, unknown>)?.domain ?? "").toLowerCase();
    const ok = /^[a-z0-9-]+\.labolabe\.tech$/.test(domain);
    return reply.code(ok ? 204 : 403).send();
  });

  await app.register(authRoutes);
  await app.register(orderRoutes);
  await app.register(cashFlowRoutes);
  await app.register(miscRoutes);
  await app.register(realtimeRoutes);
  await app.register(publicRoutes);
  // ---------- Resolução de loja para a vitrine de pedidos (Fase 1 do doc 15) ----------
  // `GET /public/tenants/resolve?host=<hostname>`: a página pública do cliente
  // final (`apps/pedido-public`) descobre a loja pelo hostname ANTES de
  // qualquer outra chamada, e sem isso ela fica presa em "Loja não encontrada".
  // Sem autenticação e com o rate limit de lookup público; o `schema_name` do
  // registry nunca sai na resposta (é topologia interna do banco).
  await app.register(tenantRoutes);
  await app.register(courierRoutes);
  await app.register(deliveryManagerRoutes);
  await app.register(ifoodRoutes);
  await app.register(paymentRoutes);
  // Webhook do Pagar.me: SEM autenticação (quem se prova é a assinatura), então
  // fica registrado à parte do paymentRoutes, que exige sessão.
  await app.register(pagarmeWebhookRoutes);
  // Canal interno com o serviço Go `pagarme-webhook/`: o Go pergunta, o Node
  // faz a transação. Auth é token de serviço (não JWT), e o Caddy não roteia
  // `/internal/*` — o Go chega pela rede interna. Ver o doc comment do arquivo.
  await app.register(pagarmeInternalRoutes);
  await app.register(printRoutes);
  await app.register(alertRoutes);
  // Provisionamento de aparelho por usuário (docs/21) — mistura rotas de
  // gerente e rotas públicas; o auth é por preHandler de rota (ver o arquivo).
  await app.register(provisioningRoutes);

  // ---------- Store info pública (§10) — nome exibido no login, sem pix key ----------
  // também expõe flags de operação que a página externa e o próprio login usam
  // para ramificar a UI antes de autenticar (ex.: delivery desligado).
  await app.register(async (publicApp) => {
    publicApp.get("/store-info", async (req) => {
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
  //
  // Ordem obrigatória (§6.1 do doc 15): o REGISTRY antes das migrations de
  // tenant. As duas podem ser o mesmo boot hoje (só existe o schema default),
  // mas o registry é o índice dos schemas de tenant e não pode depender deles.
  // Ambos usam runners separados e advisory locks distintos — ver
  // `infra/db/registry-migrate.ts` para por que o glob é separado.
  if (config.deploymentMode === "local") {
    try {
      await runRegistryMigrations();
      await runMigrations();
      // Fase 3: cada schema de tenant ativo no registry precisa estar
      // migrado. O schema default (`public` / DEFAULT_TENANT_SCHEMA) já
      // rodou acima; os demais chegam via `runMigrations({ schema })`.
      for (const tenant of await listActiveTenants()) {
        if (tenant.schemaName === resolveTenantSchema()) continue;
        await runMigrations({ schema: tenant.schemaName });
      }
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
  // Inbox do webhook do Pagar.me + reconciliação. no-op sem PAGARME_ENABLED /
  // PAGARME_SECRET_KEY.
  const pagarmeWorkers = startPagarmeWorkers();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`PDV backend rodando em modo ${config.deploymentMode} na porta ${config.port}`);

  const shutdown = async () => {
    stopDispatcher();
    stopMaintenance();
    ifoodSync.stop();
    pagarmeWorkers.stop();
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
