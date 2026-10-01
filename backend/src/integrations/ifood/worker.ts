import { db } from "../../infra/db/client.js";
import { ifoodEvents } from "../../infra/db/schema.js";
import { LOCKS, tryWithAdvisoryLock } from "../../infra/locks.js";
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
      // O `running` acima é POR PROCESSO: evita o ciclo se sobrepor a si
      // mesmo, mas não serializa contra outra instância apontada pro mesmo
      // banco. O advisory lock de transação (`pdv:ifood:worker`) é o que faz
      // isso — segurar o lock durante as chamadas HTTP ao iFood é o ponto:
      // é o que impede duas instâncias de buscarem/ACKarem o mesmo evento.
      // Réplica sem o lock pula o ciclo em silêncio (nada de erro no log).
      await tryWithAdvisoryLock(LOCKS.ifoodWorker, () => pollOnce());
    } catch (err) {
      // Um erro de ciclo não pode derrubar o processo — é a regra 1.5, e o
      // dispatcher e a maintenance já têm exatamente este `.catch()`. O iFood
      // era o único dos três sem ele, e o advisory lock tornou o buraco mais
      // largo: a aquisição do lock é `db.transaction`, então banco fora ou o
      // `connectionTimeoutMillis` de 10s (infra/db/client.ts) rejeitam em TODO
      // ciclo e escapavam por `void tick()` / `setInterval(tick, ...)` sem
      // ninguém para pegar — unhandled rejection derruba o processo no Node 15+.
      console.error("[ifood] erro no ciclo de polling:", err);
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
    // O `running` volta ao `false` pelo `finally` do `tick`, e qualquer
    // rejection de infraestrutura que escapar daqui (ver o `catch` do `tick`)
    // é logado ali — este `catch` é só para erro de negócio da chamada.
    const msg = err instanceof Error ? err.message : String(err);
    await setIfoodState(ifoodStateKeys.lastPollError, msg);
    console.error("[ifood] poll falhou:", msg);
  }
}