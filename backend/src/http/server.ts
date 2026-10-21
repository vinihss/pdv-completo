import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyMultipart from "@fastify/multipart";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config/env.js";
import { runMigrations } from "../infra/db/migrate.js";
import { runRegistryMigrations } from "../infra/db/registry-migrate.js";
import { ensureAppRole } from "../infra/db/ensure-app-role.js";
import { checkDatabaseHealth } from "../infra/db/client.js";
import { getTenantPool } from "../infra/db/tenant-db.js";
import { resolveTenantSchemaInScope } from "../infra/db/tenant-context.js";
import { startOutboxDispatcher } from "../infra/realtime/outbox-dispatcher.js";
import { startMaintenanceJobs } from "../infra/maintenance.js";
import { initStorage } from "../infra/storage/index.js";
import { initCache, getCache } from "../infra/cache/index.js";
import { getStoreSettingsUsecase } from "../infra/composition/default-usecases.js";
import { listActiveTenants } from "../infra/tenant/registry.js";
import { ensureTenantScope } from "../infra/db/tenant-context.js";

// Importações dos novos Plugins e Handlers Isolados
import { tenantContext } from "./plugins/tenant-context.plugin.js";
import { appRouter } from "./plugins/router.plugin.js";
import { configureGlobalErrorHandler } from "./errors/error-handler.js";
import { currentTenantScope } from "../infra/db/tenant-context.js";
import { DEFAULT_TENANT_ID } from "../domain/tenant.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

/**
 * `true` quando a falha das migrations no boot tem que ABORTAR o processo.
 *
 * Em produção (container de deploy com `NODE_ENV=production`, ou modo cloud)
 * subir com o schema quebrado é pior do que não subir: o `/health` só checa
 * a CONEXÃO com o banco — não o schema —, então o healthcheck ficaria VERDE
 * e o portão do deploy aprovaria um app que quebra em toda query. Abortar
 * deixa o healthcheck vermelho e o deploy parado.
 *
 * Em dev o comportamento é o de sempre: avisar e seguir, porque o banco pode
 * estar subindo junto com o app (as migrations entram na próxima reinicialização).
 *
 * O predicado é uma função separada (e recebe o `deploymentMode` por
 * parâmetro) para ser testável sem subir o app nem derrubar um banco.
 */
export function deveAbortarBootPorMigration(
  deploymentMode: "local" | "cloud" = config.deploymentMode,
): boolean {
  return process.env.NODE_ENV === "production" || deploymentMode === "cloud";
}

/**
 * O que fazer quando as migrations do boot falham.
 *
 * Em produção/cloud o boot ABORTA (relança): o `/health` só checa a conexão
 * com o banco — não o schema —, então subir com o schema quebrado deixaria
 * o healthcheck VERDE e o portão do deploy aprovaria um app que quebra em
 * toda query.
 *
 * Em dev o comportamento é o de sempre: só avisar, porque o banco pode estar
 * subindo junto com o app (as migrations entram na próxima reinicialização).
 *
 * Fora do `main()` para o teste cobrir o comportamento sem subir o app.
 */
export function tratarFalhaDeMigrationNoBoot(
  err: unknown,
  deploymentMode: "local" | "cloud" = config.deploymentMode,
): void {
  const mensagem = (err as Error).message;
  if (deveAbortarBootPorMigration(deploymentMode)) {
    throw new Error(`[boot] migrations falharam: ${mensagem}`, { cause: err });
  }
  console.warn(`[boot] migrations falharam: ${mensagem} — migrations serão aplicadas na próxima reinicialização`);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });

  // 1. Camada de Cache
  await initCache(true);
  app.decorate("cache", getCache() as any);

  // 2. Manipulação de Erros Global
  configureGlobalErrorHandler(app);

  // 3. Plugins Corporativos e Segurança
  await app.register(cors, {
    origin: config.corsOrigin
        ? config.corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
        : true,
  });
  await app.register(websocketPlugin);
  await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // 4. Inicialização do Contexto do Tenant (Ordem importa antes das rotas)
  await app.register(tenantContext);

  // 5. Inicialização do Storage e Rotas Internas Core
  initStorage();

  app.get("/health", async (_req, reply) => {
    const healthy = await checkDatabaseHealth();
    return healthy
        ? reply.code(200).send({ status: "ok", database: "connected", tag: process.env.APP_TAG ?? "" })
        : reply.code(503).send({ status: "degraded", database: "disconnected" });
  });

  app.get("/health/detailed", async (_req, reply) => {
    if (!(await checkDatabaseHealth())) return reply.code(503).send({ status: "degraded", database: "disconnected" });
    try {
      const schemaName = resolveTenantSchemaInScope();
      // O id do tenant vai junto (o `app.tenant_id` mora no startup packet do
      // pool) — é o que a policy de RLS compara com a coluna `tenant_id`.
      const pool = getTenantPool(currentTenantScope()?.tenantId ?? DEFAULT_TENANT_ID);
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ name: string; applied_at: string }>("SELECT name, applied_at FROM _migrations ORDER BY name");
        return reply.code(200).send({
          status: "ok", database: "connected", schema: schemaName, tag: process.env.APP_TAG ?? "",
          migrations: { total: rows.length, applied: rows.map((r) => ({ name: r.name, appliedAt: r.applied_at })) },
        });
      } finally { client.release(); }
    } catch (err) {
      return reply.code(500).send({ status: "error", database: "connected", error: (err as Error).message });
    }
  });

  app.get("/internal/caddy-on-demand-tls", async (req, reply) => {
    const domain = String((req.query as Record<string, unknown>)?.domain ?? "").toLowerCase();
    const root = (process.env.PLATFORM_ROOT_DOMAIN?.trim() || "umamisushiarte.com.br").toLowerCase();
    const ok = new RegExp(`^[a-z0-9-]+\\.(labolabe\\.tech|${escapeRegExp(root)})$`).test(domain);
    return reply.code(ok ? 204 : 403).send();
  });

  // 6. Registro Centralizado de Rotas do App
  await app.register(appRouter);

  // 7. Store Info Pública Isolada
  app.get("/store-info", async (req) => {
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, async () => {
      const s = await getStoreSettingsUsecase();
      return {
        merchantName: s.merchantName, merchantCity: s.merchantCity, logoUrl: s.logoUrl,
        brandColor: s.brandColor, usesDelivery: s.usesDelivery, deliveryFee: s.deliveryFee,
        deliveryFeeTiers: s.deliveryFeeTiers, deliveryPrepMinutes: s.deliveryPrepMinutes,
        minutesPerKm: s.minutesPerKm, enabledPaymentMethods: s.enabledPaymentMethods,
      };
    });
  });

  return app;
}

// O bloco main() e a função isEntrypoint() continuam idênticos abaixo...
async function main() {
  if (config.deploymentMode === "local") {
    try {
      // As migrations rodam UMA vez, no schema do app: no modelo por linha
      // (`docs/28`) todas as lojas moram no mesmo schema e o `tenant_id`
      // separa uma da outra. (Antes: uma passada de migrations por schema de
      // loja — o `docs/15`.)
      await runRegistryMigrations();
      await runMigrations();
    } catch (err) {
      // Dev: só avisa. Produção/cloud: relança e o boot morre (o healthcheck
      // fica vermelho e o portão do deploy bloqueia).
      tratarFalhaDeMigrationNoBoot(err);
    }
  }

  // O PAPEL do app (sem superuser e sem BYPASSRLS) é pré-requisito do RLS:
  // policy sem papel restrito é fachada de isolamento. Roda em TODOS os modos
  // (não só no local) porque é ele quem cria o papel na primeira vez que a
  // `DATABASE_URL` passa a apontar para ele.
  //
  // Falha aqui NÃO derruba o boot: o app pode continuar com o papel atual
  // (o `APP_DB_PASSWORD` vazio = nada muda). Se a `DATABASE_URL` já aponta
  // para um papel que não existe, quem acusa é o healthcheck — e o portão do
  // deploy bloqueia, que é o sinal certo.
  try {
    await ensureAppRole();
  } catch (err) {
    console.error("[app-role] não consegui garantir o papel do app:", err instanceof Error ? err.message : err);
  }

  const app = await buildApp();
  const stopDispatcher = startOutboxDispatcher();
  const stopMaintenance = startMaintenanceJobs();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`PDV backend rodando em modo ${config.deploymentMode} na porta ${config.port}`);

  const shutdown = async () => {
    stopDispatcher(); stopMaintenance(); await app.close(); process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const stripExt = (p: string) => path.resolve(p).replace(/\.(js|mjs|cjs|ts|mts|cts)\$/, "");
  return stripExt(entry) === stripExt(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
