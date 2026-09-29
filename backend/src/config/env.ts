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
  // ---------- WhatsApp Cloud API / Embedded Signup ----------
  // O token NÃO vem mais de env: quem conecta é o dono da loja, pelo
  // Embedded Signup, e o token fica por WABA em `whatsapp_connection`
  // (migration 0002). O que fica em env é só o do APP da Meta — o mesmo
  // para todas as lojas que se conectarem nele. Ver
  // docs/10-whatsapp-embedded-signup.md.
  //
  // Nada aqui trava o boot: a integração só é inicializável quando o
  // gerente usa (e a UI esconde o botão enquanto faltar algo), então uma
  // instalação sem WhatsApp continua subindo normalmente.
  metaAppId: process.env.META_APP_ID, // id do app Meta (vai ao browser pro FB SDK)
  metaAppSecret: process.env.META_APP_SECRET, // troca o code server-side + assina appsecret_proof
  // Configuração v4 do Embedded Signup, criada no painel da Meta
  // (Business Settings > Embedded Signup). É ela que declara produtos,
  // assets e permissões — o v4 não leva mais isso na chamada do JS.
  whatsappSignupConfigId: process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
  // A configuração do Builder é amarrada a uma versão do Graph API: app id
  // e versão precisam sair do MESMO painel. v25.0 é a atual da doc do
  // Embedded Signup v4.
  whatsappGraphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v25.0",
  // Base da Graph — variável de ambiente para os testes apontarem para um
  // stub local em vez da rede (mesmo truque do IFOOD_MOCK).
  whatsappGraphBaseUrl: process.env.WHATSAPP_GRAPH_BASE_URL ?? "https://graph.facebook.com",
  // Token do handshake do webhook (GET ?hub.mode=subscribe).
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  // Legado: token/número globais de quando o dono da WABA rodava o próprio
  // PDV. Só entram em jogo se NÃO existir nenhuma whatsapp_connection ativa
  // (ver state.ts#resolveConnection), e aí com um warn — o caminho oficial
  // hoje é o Embedded Signup.
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
  // Impressão térmica — o frontend se conecta diretamente ao MenuForma Print
  // Agent via WebSocket (ws://localhost:8765). O backend não tem mais rotas
  // de impressão. Ver frontend/src/entities/printer/menuForma.js.
};
