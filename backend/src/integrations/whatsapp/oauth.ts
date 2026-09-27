import crypto from "node:crypto";
import { whatsappConfig } from "./config.js";

/**
 * Lado servidor do Embedded Signup: troca o código de autorização pelo
 * token do cliente, valida os escopos, registra o número na Cloud API e
 * assina o app nos webhooks da WABA.
 *
 * Por que server-side: a troca exige o APP SECRET. Ele nunca vai para o
 * browser (ver entities/whatsapp no frontend, que só manda o code).
 * Ver docs/10-whatsapp-embedded-signup.md.
 *
 * Todas as chamadas lançam `GraphApiError` no corpo de erro — a versão
 * anterior do client engolia a resposta (`await fetch(...)` sem checar
 * res.ok), então um token expirado ou um escopo faltando viravam silêncio.
 */

export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly fbtraceId?: string
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

/**
 * `appsecret_proof` (HMAC-SHA256 do token com o app secret). A Meta exige
 * isso em toda chamada autenticada por token de cliente: sem ele, um token
 * vazado passa a ser utilizável por qualquer um que o tenha. A troca do
 * code NÃO leva — ainda não existe token nessa chamada.
 */
function appSecretProof(accessToken: string): string | null {
  const secret = whatsappConfig.appSecret;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(accessToken, "utf8").digest("hex");
}

async function graphFetch(
  path: string,
  opts: {
    method?: "GET" | "POST";
    search?: Record<string, string | undefined>;
    body?: unknown;
    /** Bearer do cliente + appsecret_proof. */
    accessToken?: string;
  } = {}
): Promise<any> {
  const url = new URL(whatsappConfig.url(path));
  for (const [key, value] of Object.entries(opts.search ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.accessToken) {
    headers.Authorization = `Bearer ${opts.accessToken}`;
    const proof = appSecretProof(opts.accessToken);
    if (proof) headers["appsecret_proof"] = proof;
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const err = payload?.error;
    throw new GraphApiError(
      res.status,
      err?.message ?? `Graph API respondeu ${res.status} em ${opts.method ?? "GET"} ${path}`,
      err?.code,
      err?.error_subcode,
      err?.fbtrace_id
    );
  }

  return payload;
}

// ============================================================
// 1. Troca do código pelo token do cliente
// ============================================================

/**
 * `GET /oauth/access_token` — troca o code pelo Business Integration System
 * User (BISU) token, escopado nos assets que o cliente autorizou.
 *
 * O código é de USO ÚNICO e vive 30 SEGUNDOS. Se a chamada falhar por
 * timeout, NÃO dá para repetir: a segunda tentativa falha com
 * "invalid verification code" e o cliente precisa refazer o Embedded
 * Signup. Por isso o chamador trata o erro como terminal.
 */
export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  /** epoch ms; ausente quando o token não expira (caso normal do v4). */
  expiresInMs: number | null;
  tokenType: string | null;
}> {
  if (!whatsappConfig.appId || !whatsappConfig.appSecret) {
    throw new GraphApiError(500, "META_APP_ID/META_APP_SECRET não configurados.");
  }

  const payload = await graphFetch("/oauth/access_token", {
    search: {
      client_id: whatsappConfig.appId,
      client_secret: whatsappConfig.appSecret,
      code,
    },
  });

  const accessToken = payload?.access_token;
  if (!accessToken) {
    throw new GraphApiError(500, "A troca do código não devolveu access_token.", payload?.error?.code);
  }

  return {
    accessToken,
    expiresInMs:
      typeof payload?.expires_in === "number" ? payload.expires_in * 1000 : null,
    tokenType: payload?.token_type ?? null,
  };
}

// ============================================================
// 2. Escopos — a fonte da verdade
// ============================================================

export interface DebugTokenInfo {
  /** WABAs cujos escopos o token carrega (granular_scopes[].target_ids). */
  wabaIds: string[];
  hasManagement: boolean;
  hasMessaging: boolean;
  expiresAt: number | null; // epoch ms
  appId: string | null;
}

/** Escopo que o app precisa para operar a WABA do cliente. */
const SCOPE_MANAGEMENT = "whatsapp_business_management";
const SCOPE_MESSAGING = "whatsapp_business_messaging";

/**
 * `GET /debug_token` — pergunta ao token o que ele DE FATO carrega.
 *
 * Por que não confiar no postMessage do browser: o `postMessage` traz
 * `waba_id` e (na maioria das vezes) `phone_number_id`, mas a Meta OMITE o
 * phone_number_id em alguns caminhos — notadamente o onboarding de conta
 * já existente no app WhatsApp Business. `granular_scopes` é a resposta
 * autoritativa do servidor, e é o que se consulta quando o postMessage não
 * chegou ou veio incompleto.
 */
export async function debugToken(accessToken: string): Promise<DebugTokenInfo> {
  if (!whatsappConfig.appId || !whatsappConfig.appSecret) {
    throw new GraphApiError(500, "META_APP_ID/META_APP_SECRET não configurados.");
  }

  // debug_token exige o APP access token (id|secret), não o do cliente.
  const appAccessToken = `${whatsappConfig.appId}|${whatsappConfig.appSecret}`;
  const payload = await graphFetch("/debug_token", {
    search: { input_token: accessToken },
    accessToken: appAccessToken,
  });

  const data = payload?.data ?? {};
  const granular: any[] = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];

  const wabaIds = new Set<string>();
  let hasManagement = false;
  let hasMessaging = false;

  for (const scope of granular) {
    const name = scope?.scope;
    if (name === SCOPE_MANAGEMENT) hasManagement = true;
    if (name === SCOPE_MESSAGING) hasMessaging = true;
    // target_ids mistura WABA e business portfolio; o prefixo do id
    // diferencia, mas o filtro definitivo é cruzando com as phone_numbers
    // da WABA — aqui só colecionamos candidatos.
    for (const target of scope?.target_ids ?? []) {
      if (typeof target === "string") wabaIds.add(target);
    }
  }

  return {
    wabaIds: [...wabaIds],
    hasManagement,
    hasMessaging,
    expiresAt: typeof data.expires_at === "number" ? data.expires_at * 1000 : null,
    appId: data.app_id ?? null,
  };
}

// ============================================================
// 3. Números de telefone da WABA
// ============================================================

export interface WabaPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

/** `GET /{waba-id}/phone_numbers` — o número que we'll enviar/receber. */
export async function listPhoneNumbers(wabaId: string, accessToken: string): Promise<WabaPhoneNumber[]> {
  const payload = await graphFetch(`/${wabaId}/phone_numbers`, { accessToken });
  return (payload?.data ?? []).map((n: any) => ({
    id: n.id,
    displayPhoneNumber: n.display_phone_number ?? null,
    verifiedName: n.verified_name ?? null,
    qualityRating: n.quality_rating ?? null,
  }));
}

// ============================================================
// 4. Perfil da conta de negócio
// ============================================================

export interface WabaBusinessProfile {
  about: string | null;
  vertical: string | null;
  description: string | null;
  email: string | null;
  website: string | null;
}

/** `GET /{waba-id}/business_profile` — nome/vertical exibidos no WhatsApp. */
export async function getBusinessProfile(
  wabaId: string,
  accessToken: string
): Promise<WabaBusinessProfile | null> {
  try {
    const payload = await graphFetch(`/${wabaId}/business_profile`, {
      search: { fields: "about,vertical,description,email,website" },
      accessToken,
    });
    const entries = payload?.data ?? [];
    if (entries.length === 0) return null;
    const p = entries[0] ?? {};
    return {
      about: p.about ?? null,
      vertical: p.vertical ?? null,
      description: p.description ?? null,
      email: p.email ?? null,
      website: p.website ?? null,
    };
  } catch {
    // Perfil é cosmético: a conexão funciona sem ele (alguns WABAs não têm
    // business_profile). Não vale falhar o onboarding por isso.
    return null;
  }
}

// ============================================================
// 5. Registro do número na Cloud API
// ============================================================

/**
 * `POST /{phone-number-id}/register` — habilita o número na Cloud API.
 *
 * O número vem do Embedded Signup ainda "em verificação por SMS"; o
 * register é o passo que o libera para enviar/receber de verdade. Sem
 * ele o envio falha com erro 803 / "not registered".
 */
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  await graphFetch(`/${phoneNumberId}/register`, {
    method: "POST",
    body: { messaging_product: "whatsapp" },
    accessToken,
  });
}

// ============================================================
// 6. Assinatura do app nos webhooks da WABA
// ============================================================

/**
 * `POST /{waba-id}/subscribed_apps` — assina NOSSO app nos webhooks da WABA
 * do cliente. É o passo mais fácil de esquecer e o que mais aparece como
 * bug: sem ele a WABA é do cliente, o app não é o dono, e NENHUM webhook
 * chega — o envio funciona, a resposta do cliente não aparece.
 *
 * É idempotente na prática: assinar duas vezes não muda nada.
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<boolean> {
  try {
    await graphFetch(`/${wabaId}/subscribed_apps`, { method: "POST", accessToken });
    return true;
  } catch (err) {
    // 3 é "subscribed to other apps" no objeto WABA, não erro do nosso
    // signup. A Meta devolve 200 nos dois casos; o catch cobre
    // respostas inesperadas de Graph que não invalidam a conexão.
    if (err instanceof GraphApiError && (err.subcode === 3 || err.subcode === 33)) return true;
    throw err;
  }
}

/**
 * Descobre o portfolio de negócio do cliente (o "business_id"). O
 * postMessage costuma trazer, mas se vier vazio o endpoint abaixo é a
 * fonte. Best-effort: sem isso ainda dá para enviar e receber.
 */
export async function getBusinessIdForWaba(wabaId: string, accessToken: string): Promise<string | null> {
  try {
    const payload = await graphFetch(`/${wabaId}`, { search: { fields: "id" }, accessToken });
    const business = payload?.business;
    return business?.id ?? null;
  } catch {
    return null;
  }
}
