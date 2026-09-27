import { db } from "../../infra/db/client.js";
import { ifoodEvents } from "../../infra/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { ifoodConfig, isIfoodEnabled, isIfoodMock } from "./config.js";
import { ifoodFetch } from "./client.js";
import { startIfoodMock, getIfoodMockState } from "./mock.js";
import { handleIfoodOrderEvent } from "./order-handler.js";
import {
  ifoodStateKeys,
  setIfoodState,
  resolveMerchantIfNeeded,
} from "./state.js";
import type { PollEventsResponse } from "./order.types.js";

// Worker de polling da iFood Order API (evento → pedido local). Roda no mesmo
// processo do backend (padrão do startOutboxDispatcher) — ver docs/06-ifood-integration.md.
// Ciclo recomendado pelo iFood: poll a cada 30s, persistir, ACK.
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startIfoodSync(): { stop: () => void } {
  if (!isIfoodEnabled()) {
    console.log("[ifood] integração desabilitada (IFOOD_SYNC_ENABLED=false e/ou sem credenciais) — worker não iniciado");
    return { stop: () => {} };
  }

  let mockServer: ReturnType<typeof startIfoodMock> | null = null;
  if (isIfoodMock()) {
    mockServer = startIfoodMock();
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce();
    } finally {
      running = false;
    }
  };

  // primeiro poll imediato + ciclo fixo
  void tick();
  timer = setInterval(tick, ifoodConfig.pollingIntervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (mockServer) mockServer.close();
    },
  };
}

async function pollOnce(): Promise<void> {
  await setIfoodState(ifoodStateKeys.lastPollAt, new Date().toISOString());
  try {
    await resolveMerchantIfNeeded();

    const data = await ifoodFetch<PollEventsResponse>(ifoodConfig.orderUrl("/orders:polling"));
    if (!data || !Array.isArray(data.events) || data.events.length === 0) return;

    const ackIds: string[] = [];
    for (const ev of data.events) {
      const result = await handleIfoodOrderEvent(ev);
      if (result === "acked") ackIds.push(ev.id);
    }
    if (ackIds.length === 0) return;

    // Confirma leitura só dos eventos efetivamente tratados — em batch (até
    // 2000 ids por request, guia do iFood).
    await ifoodFetch(ifoodConfig.orderUrl("/orders:acknowledgment"), {
      method: "POST",
      body: { acknowledgedEventIds: ackIds },
    });
    await db
      .update(ifoodEvents)
      .set({ status: "acked" })
      .where(inArray(ifoodEvents.id, ackIds));

    await setIfoodState(ifoodStateKeys.lastPollError, "");
  } catch (err) {
    // Falha de rede/token não derruba o worker; guarda pro painel do gerente.
    const msg = err instanceof Error ? err.message : String(err);
    await setIfoodState(ifoodStateKeys.lastPollError, msg);
    console.error("[ifood] poll falhou:", msg);
  }
}