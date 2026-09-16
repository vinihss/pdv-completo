import { config } from "../../config/env.js";

// Conexão com a iFood Order/Catalog API. Em desenvolvimento (sem credenciais
// reais) IFOOOD_MOCK=true faz o client apontar para o mock local em
// http://localhost:IFOOD_MOCK_PORT — mesmo caminho HTTP, sem rede externa.

export const ifoodConfig = {
  syncEnabled: config.ifoodSyncEnabled,
  clientId: config.ifoodClientId,
  clientSecret: config.ifoodClientSecret,
  merchantId: config.ifoodMerchantId,
  pollingIntervalMs: config.ifoodPollingIntervalMs,
  mockPort: config.ifoodMockPort,
  baseUrl: config.ifoodMock
    ? `http://localhost:${config.ifoodMockPort}`
    : config.ifoodBaseUrl,
  // URLs reais do iFood (base prod/sandbox conforme env)
  tokenUrl: () => `${ifoodConfig.baseUrl}/authentication/v1.0/oauth/token`,
  merchantsUrl: () => `${ifoodConfig.baseUrl}/authentication/v1.0/merchants`,
  orderUrl: (path = "") => `${ifoodConfig.baseUrl}/order/v1.0${path}`,
  catalogUrl: (merchantId: string, path = "") =>
    `${ifoodConfig.baseUrl}/catalog/v2.0/merchants/${merchantId}${path}`,
};

// Integração só roda se explicitamente habilitada E houver credenciais (ou mock).
export function isIfoodEnabled(): boolean {
  if (config.ifoodMock) return true; // mock roda sem credenciais reais
  if (!config.ifoodSyncEnabled) return false;
  return Boolean(config.ifoodClientId && config.ifoodClientSecret);
}

export function isIfoodMock(): boolean {
  return config.ifoodMock === true;
}