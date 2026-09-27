import { ifoodConfig, isIfoodEnabled, isIfoodMock } from "./config.js";
import { clearIfoodState, getIfoodState, ifoodStateKeys, setIfoodState } from "./state.js";

// Wrappers do protocolo iFood: OAuth2 client_credentials (app centralizado)
// + fetch autenticado com renovação de token. Documentação de referência:
// developer.ifood.com.br — Authentication (authentication/v1.0/oauth/token).

export class IfoodApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
    public retryable = false,
  ) {
    super(message);
    this.name = "IfoodApiError";
  }
}

function tokenExpiryMs(expiresIn: number): number {
  // margem de segurança: renova antes de expirar
  return Date.now() + Math.max(0, expiresIn - 120) * 1000;
}

export async function getAccessToken(): Promise<string> {
  if (!isIfoodEnabled()) {
    throw new IfoodApiError(
      "Integração iFood desabilitada (IFOOD_SYNC_ENABLED=false ou sem credenciais)",
      500,
      undefined,
      false,
    );
  }

  const cached = await getIfoodState(ifoodStateKeys.accessToken);
  const expiresAt = Number((await getIfoodState(ifoodStateKeys.tokenExpiresAt)) ?? 0);
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  if ((!ifoodConfig.clientId || !ifoodConfig.clientSecret) && !isIfoodMock()) {
    throw new IfoodApiError("IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não configurados", 500, undefined, true);
  }

  const form = new URLSearchParams({ grantType: "client_credentials" });
  if (ifoodConfig.clientId) form.set("clientId", ifoodConfig.clientId);
  if (ifoodConfig.clientSecret) form.set("clientSecret", ifoodConfig.clientSecret);

  const res = await fetch(ifoodConfig.tokenUrl(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });

  if (!res.ok) {
    throw new IfoodApiError(`Falha ao obter token do iFood (HTTP ${res.status})`, res.status, await res.text().catch(() => undefined), true);
  }

  const data = (await res.json()) as { accessToken?: string; expiresIn?: number };
  if (!data.accessToken) {
    throw new IfoodApiError("Resposta de token do iFood sem accessToken", res.status, data, true);
  }
  setIfoodState(ifoodStateKeys.accessToken, data.accessToken);
  setIfoodState(ifoodStateKeys.tokenExpiresAt, String(tokenExpiryMs(data.expiresIn ?? 21_600)));
  return data.accessToken;
}

// fetch autenticado; nulo para 204/202 sem corpo. Renova o token uma vez em 401.
export async function ifoodFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
  retry = true,
): Promise<T | null> {
  const method = options.method ?? "GET";
  const token = await getAccessToken();

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && retry) {
    clearIfoodState(ifoodStateKeys.accessToken);
    clearIfoodState(ifoodStateKeys.tokenExpiresAt);
    return ifoodFetch(url, options, false);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new IfoodApiError(`iFood API HTTP ${res.status} em ${url}${text ? `: ${text.slice(0, 300)}` : ""}`, res.status, text, res.status >= 500);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Merchant (resolução do merchantId quando não informado em env)
// ---------------------------------------------------------------------------
export interface IfoodMerchant {
  id: string;
  name: string;
}

export async function listMerchants(): Promise<IfoodMerchant[]> {
  const data = await ifoodFetch<IfoodMerchant[]>(ifoodConfig.merchantsUrl());
  return Array.isArray(data) ? data : [];
}

export async function resolveMerchantId(): Promise<{ id: string; name?: string } | null> {
  if (ifoodConfig.merchantId) return { id: ifoodConfig.merchantId };
  const merchants = await listMerchants();
  if (merchants.length === 0) return null;
  return { id: merchants[0].id, name: merchants[0].name };
}