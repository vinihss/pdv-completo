import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

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

export const config = {
  deploymentMode,
  databaseUrl: required("DATABASE_URL", "sqlite:./data/data.db"),
  // Diretório das fotos de produto servidas em /uploads. Relativo ao cwd
  // (em dev: backend/; em docker: /app). Criado no boot (server.ts).
  uploadsDir: process.env.UPLOADS_DIR ?? "uploads",
  jwtSecret: jwtSecret(),
  syncEnabled: process.env.SYNC_ENABLED === "true",
  syncTargetUrl: process.env.SYNC_TARGET_URL,
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Em produção (deploy real, exposto à internet), restringe a quem pode
  // chamar a API via browser. Em dev, undefined = todas as origens liberadas
  // (útil pra tocar o Vite em outra porta sem precisar configurar nada).
  corsOrigin: process.env.CORS_ORIGIN, // ex: "https://pdv.seudominio.com.br"
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
};
