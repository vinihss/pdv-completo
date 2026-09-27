import "dotenv/config";

const deploymentMode = (process.env.DEPLOYMENT_MODE ?? "local") as "local" | "cloud";

// Em produção (container de deploy com NODE_ENV=production, ou modo cloud),
// o JWT_SECRET é obrigatório e não pode ser o valor de exemplo — do contrário
// a API sobe com segredo conhecido. Em dev local, o fallback é aceitável.
function jwtSecret(): string {
  const v = process.env.JWT_SECRET;
  const production = process.env.NODE_ENV === "production" || deploymentMode === "cloud";
  if (production) {
    if (!v || v === "dev-secret-change-me" || v.length < 32) {
      throw new Error("JWT_SECRET é obrigatório em produção — gere com: openssl rand -hex 32");
    }
    return v;
  }
  return v ?? "dev-secret-change-me";
}

// Postgres é o único banco suportado. Aceita postgres:// e postgresql://.
function databaseUrl(): string {
  const v = process.env.DATABASE_URL;
  if (!v) throw new Error("DATABASE_URL é obrigatório (ex: postgres://user:pass@host:5432/dbname)");
  if (!v.startsWith("postgres://") && !v.startsWith("postgresql://")) {
    throw new Error(`DATABASE_URL deve começar com postgres:// ou postgresql:// (recebido: ${v.split(":")[0]}:…)`);
  }
  return v;
}

export const config = {
  // "local" (mini-PC/NUC via Docker) ou "cloud" (Postgres gerenciado).
  // Controla as flags de operação e o JWT_SECRET — o banco é Postgres nos dois.
  deploymentMode,
  databaseUrl: databaseUrl(),
  // Conexões simultâneas no pool. O PDV é transacional e concorre em
  // regime baixo, mas o número precisa acompanhar o número de cores da
  // máquina (o backend segura 1 conexão por transação + queries avulsas).
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // Diretório das fotos de produto servidas em /uploads. Relativo ao cwd
  // (em dev: backend/; em docker: /app). Criado no boot (server.ts).
  uploadsDir: process.env.UPLOADS_DIR ?? "uploads",
  jwtSecret: jwtSecret(),
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Em produção (deploy real, exposto à internet), restringe a quem pode
  // chamar a API via browser. Em dev, undefined = todas as origens liberadas
  // (útil pra tocar o Vite em outra porta sem precisar configurar nada).
  corsOrigin: process.env.CORS_ORIGIN, // ex: "https://app.seudominio.com.br"
  // WhatsApp Cloud API — vazios em dev; whatsapp.routes.ts recusa
  // (não trava o boot) se estiverem faltando quando o webhook é chamado.
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  // Página externa de cardápio/checkout — o bot linka pra cá em vez de
  // conduzir carrinho por texto (decisão: "checkout por fora" — ver
  // 04-delivery-self-service-integration.md).
  externalMenuUrl: process.env.EXTERNAL_MENU_URL ?? "https://pedido.seudominio.com.br",
  // Integração iFood (Order + Catalog API) — módulo in-process, ver
  // docs/06-ifood-integration.md. Só ativa com IFOOD_SYNC_ENABLED=true E
  // credenciais presentes (ou IFOOD_MOCK=true para desenvolvimento).
  ifoodSyncEnabled: process.env.IFOOD_SYNC_ENABLED === "true",
  ifoodClientId: process.env.IFOOD_CLIENT_ID,
  ifoodClientSecret: process.env.IFOOD_CLIENT_SECRET,
  ifoodMerchantId: process.env.IFOOD_MERCHANT_ID, // opcional — auto-listado via /merchants
  ifoodPollingIntervalMs: Number(process.env.IFOOD_POLLING_INTERVAL_MS ?? 30000),
  ifoodMock: process.env.IFOOD_MOCK === "true",
  ifoodMockPort: Number(process.env.IFOOD_MOCK_PORT ?? 3999),
  ifoodBaseUrl: process.env.IFOOD_BASE_URL ?? "https://merchant-api.ifood.com.br",
};
