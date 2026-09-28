import { config } from "../../config/env.js";

/**
 * Client HTTP do daemon de impressão térmica (printer/).
 *
 * O daemon roda localmente (127.0.0.1:8080) e recebe JSON estruturado —
 * ele renderiza ESC/POS e envia TCP pra impressora. O backend nunca conhece
 * ESC/POS nem o endereço TCP da impressora.
 *
 * Todas as chamadas têm timeout curto e NUNCA lançam erro: falhas de impressão
 * são logadas e o daemon tem sua própria fila de retry. O backend não bloqueia
 * nem quebra se o daemon estiver fora.
 */

const TIMEOUT_MS = 5000;

async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  const url = `${config.printerDaemonUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[printer] ${path} → ${res.status}: ${text}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[printer] ${path} falhou:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DaemonJob {
  id: string;
  order_id: string;
  destination: string;
  status: string;
  attempts: number;
  last_error: string;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface DaemonPrinterStatus {
  destination: string;
  address: string;
  reachable: boolean;
  status_supported: boolean;
  ready: boolean;
  paper: string;
  cover_open: boolean;
  offline: boolean;
  error: boolean;
  cutter_error: boolean;
  raw: Record<string, number>;
  message?: string;
  checked_at: string;
}

export interface DaemonOrder {
  number: string;
  created_at: string;
  type: string;
  notes: string;
  items: Array<{
    name: string;
    quantity: number;
    unit_price_cents: number;
    notes: string;
    addons: string[];
  }>;
  total_cents: number;
  customer?: { name: string; phone: string };
  delivery?: {
    address: string;
    number: string;
    complement: string;
    neighborhood: string;
    reference: string;
  };
  payment?: { method: string; change_cents: number };
}

export interface DaemonPrintRequest {
  job_id: string;
  order_id: string;
  destination: string;
  order: DaemonOrder;
}

export const printerClient = {
  async enqueuePrint(req: DaemonPrintRequest): Promise<{ job_id: string; status: string } | null> {
    return call<{ job_id: string; status: string }>("/api/print", {
      method: "POST",
      body: JSON.stringify(req),
    });
  },

  async getJobs(): Promise<DaemonJob[]> {
    const res = await call<DaemonJob[]>("/api/jobs");
    return res ?? [];
  },

  async retryJob(jobId: string): Promise<{ job_id: string; status: string } | null> {
    return call<{ job_id: string; status: string }>("/api/jobs/retry", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    });
  },

  async getPrinterStatus(destination: string): Promise<DaemonPrinterStatus | null> {
    return call<DaemonPrinterStatus>(`/api/printers/status?destination=${encodeURIComponent(destination)}`);
  },

  async health(): Promise<boolean> {
    const res = await call<{ status: string }>("/health");
    return res?.status === "ok";
  },
};
