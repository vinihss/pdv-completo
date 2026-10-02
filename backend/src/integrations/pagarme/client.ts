import { pagarmeConfig } from "./config.js";
import type { PagarmeErrorBody } from "./types.js";

// Cliente HTTP da Pagar.me Core V5.
//
// Responsabilidades, e só elas: autenticar, chamar, dar timeout, classificar
// erro, logar sem vazar segredo e serializar. NENHUMA regra de negócio — quem
// decide o que um `paid` significa é o mapper e a aplicação, nunca este arquivo.

// Erro da chamada HTTP, já classificado pela spec §26. `retryable` é a
// resposta honesta a "o gateway pode repetir sozinho?": só 429 e 5xx.
export class PagarmeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly kind: "validation" | "auth" | "conflict" | "rate_limit" | "unavailable" | "unknown",
    public readonly retryable: boolean,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PagarmeApiError";
  }
}

function classify(status: number): { kind: PagarmeApiError["kind"]; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 409) return { kind: "conflict", retryable: false };
  if (status === 429) return { kind: "rate_limit", retryable: true };
  // 4xx restante é recusa de regra/validação — repetir não muda a resposta.
  if (status >= 400 && status < 500) return { kind: "validation", retryable: false };
  if (status >= 500) return { kind: "unavailable", retryable: true };
  return { kind: "unknown", retryable: false };
}

/**
 * Extrai uma mensagem legível do corpo de erro. A doc oficial não define o
 * envelope (o OpenAPI traz `properties: {}`), então isto é tolerante: tenta as
 * formas que a API costuma usar e cai no texto cru.
 */
function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as PagarmeErrorBody;
    if (typeof b.message === "string" && b.message) return b.message;
    if (Array.isArray(b.errors) && b.errors.length > 0) {
      const parts = b.errors
        .map((e) => (e?.field ? `${e.field}: ${e.message ?? ""}`.trim() : (e?.message ?? "")))
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    }
  }
  if (typeof body === "string" && body.trim()) return body.slice(0, 300);
  return `HTTP ${status} sem corpo de erro`;
}

export interface PagarmeFetchOptions {
  method?: string;
  body?: unknown;
  /** Propagado no `x-correlation-id` — spec §25. */
  correlationId?: string;
}

/**
 * `GET` que devolve `null` em 404 — o caso de uso é `find()`, em que "o gateway
 * não conhece esse id" é um resultado normal e não um erro.
 */
export async function pagarmeFetch<T = unknown>(
  pathOrUrl: string,
  options: PagarmeFetchOptions = {},
): Promise<T | null> {
  const method = options.method ?? "GET";
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${pagarmeConfig.baseUrl}${pathOrUrl}`;
  const secretKey = pagarmeConfig.secretKey;

  if (!secretKey) {
    throw new PagarmeApiError("PAGARME_SECRET_KEY não configurada", 0, "auth", false);
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    // A V5 declara `securitySchemes: { sec0: { type: "http", scheme: "basic" } }`
    // — é HTTP Basic com a secret key como usuário e senha vazia. NÃO é Bearer.
    authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.correlationId) headers["x-correlation-id"] = options.correlationId;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(pagarmeConfig.timeoutMs),
    });
  } catch (err) {
    // Timeout e rede caem aqui. `retryable: true` porque o gateway pode estar
    // momentaneamente fora — mas NENHUM retry é feito dentro desta função: quem
    // repete é o worker, e só em operação idempotente (ver gateway.ts e a nota
    // sobre POST de criação).
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new PagarmeApiError(
      isTimeout ? `timeout de ${pagarmeConfig.timeoutMs}ms em ${method} ${url}` : `falha de rede em ${method} ${url}`,
      0,
      "unavailable",
      true,
    );
  }

  if (res.status === 404) return null;

  const rawText = await res.text().catch(() => "");
  let parsed: unknown = undefined;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  if (!res.ok) {
    const { kind, retryable } = classify(res.status);
    throw new PagarmeApiError(errorMessage(res.status, parsed), res.status, kind, retryable, parsed);
  }

  return parsed as T | null;
}

/**
 * Chamadas que podem ser repetidas porque não movem dinheiro: leitura de
 * pedido. `POST /orders` (criação) NÃO entra aqui — repetir uma criação sem
 * chave de idempotência do gateway é exatamente a cobrança duplicada que a
 * spec §26 proíbe ("nunca repetir cegamente uma operação financeira").
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}