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
  // ---------- Cardápio externo ----------
  // Página pública de cardápio/checkout (self-service) — usada pelo link
  // que o PDV entrega ao cliente. Ver
  // 04-delivery-self-service-integration.md.
  externalMenuUrl: process.env.EXTERNAL_MENU_URL ?? "https://pedido.seudominio.com.br",
  // Impressão térmica — daemon local (printer/). O daemon escuta em
  // 127.0.0.1:8080 e recebe JSON estruturado (não ESC/POS); ele renderiza e
  // envia TCP pra impressora. O backend só chama a API local. Em Docker, o
  // container do backend alcança o daemon via host_gateway ou sidecar.
  printerDaemonUrl: process.env.PRINTER_DAEMON_URL ?? "http://127.0.0.1:8080",
  // ---------- Email (SMTP) ----------
  // Nada aqui derruba o boot: sem SMTP_HOST o envio apenas reporta
  // {sent:false, reason:"not_configured"}. O seam `setMailerForTests`
  // permite que os testes injetem um fake sem tocar na rede.
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  mailFrom: process.env.MAIL_FROM ?? "no-reply@localhost",
};
