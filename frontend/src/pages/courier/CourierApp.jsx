import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { deliverDelivery, dispatchDelivery, failDelivery, useDeliveries } from "@/entities/delivery";
import { useToast, Toast } from "@/shared/components";
import { groupDeliveries } from "./model/deliveries.js";
import { useNewDeliveryAlert } from "./model/useNewDeliveryAlert.js";
import { useOnlineStatus } from "./model/useOnlineStatus.js";
import { useScreenWakeLock } from "./model/useScreenWakeLock.js";
import DeliveryCard from "./ui/DeliveryCard.jsx";
import FailedDeliveryCard from "./ui/FailedDeliveryCard.jsx";
import FailReasonModal from "./ui/FailReasonModal.jsx";
import {
  CourierEmpty,
  CourierError,
  CourierSkeleton,
  OfflineBanner,
  QueueEmpty,
  StaleWarning,
} from "./ui/CourierStates.jsx";

/** Tick do cronômetro dos cards. 30s: o rótulo é em minutos e a tela é usada
 *  no sol, bateria importa. Só redesenha — nunca vai à rede. */
const CLOCK_TICK_MS = 30_000;

/**
 * Tela do entregador.
 *
 * Rota separada e minimalista, não uma view restrita do painel do manager
 * (decisão registrada em `docs/04-delivery-self-service-integration.md`
 * "Superfícies de UI") — sem as telas do gerente, só o trabalho de quem está
 * na rua. O menu do app entra como trilho de ícones (perfil de tela única).
 *
 * O desenho inteiro segue uma realidade só: mão ocupada, sol forte, 4G de rua,
 * uma mão só no celular. Por isso (1) o status é a ESTRUTURA da tela — o que
 * está em rota sobe para hero e a fila desce, porque ler cards em ordem de
 * criação faz a entrega ativa ficar no meio da lista; (2) a ação primária tem
 * 56px, alcance de polegar; (3) falha é 1 toque com motivo presetado; (4) um
 * pedido novo que entra faz SOM, porque o entregador pode estar com o app no
 * bolso, e olhando a tela ele não está.
 *
 * Server-authoritative como o resto do app: mutation `await` e reload, sem
 * otimismo. O `useDeliveries` é de outro agente — a tela só OBSERVA o que ele
 * devolve.
 */
export default function CourierApp() {
  const { deliveries, loading, reload, error } = useDeliveries("courier");
  const { toast, showToast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState(null);
  const [failing, setFailing] = useState(null); // entrega com o modal de motivo aberto
  const [reason, setReason] = useState("");
  const [loadError, setLoadError] = useState(null); // reload que estourou (o hook não expõe `error` ainda)

  const online = useOnlineStatus();
  useScreenWakeLock();

  const list = useMemo(() => (Array.isArray(deliveries) ? deliveries.filter(Boolean) : []), [deliveries]);
  const { active, queue, failed } = useMemo(() => groupDeliveries(list), [list]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * Recarga com `try/catch` local. O `reload` do hook hoje NÃO tem `catch`: a
   * promise rejeita (e o `useEffect` interno do hook deixa a rejeição sem
   * tratamento). Sem este wrapper o retry não teria nem retorno nem estado de
   * erro para desenhar; com o `error` do contrato entrando no hook, `error`
   * abaixo passa a ser a fonte primária e este caminho vira só o reforço.
   */
  const reloadList = useCallback(async () => {
    try {
      await reload();
      setLoadError(null);
    } catch (e) {
      setLoadError(e ?? new Error("Falha ao carregar entregas"));
    }
  }, [reload]);

  // Volta do background: quem ficou 10 min no carro precisa conferir o
  // servidor — `useRealtime` reidrata o socket, mas a lista parada em tela é
  // o que ele lê.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") reloadList();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reloadList]);

  /**
   * Reconexão: o sinal voltou (`online` false → true), recarrega.
   *
   * O `useRealtime` já recarrega quando o SOCKET reabre, mas em 4G de rua o
   * caso comum é o inverso: o SO avisa "online" e o WebSocket continua
   * aparentemente aberto (proxy transparente, portal de operador) — então o evento
   * de rede é o único gatilho confiável que a tela tem. Só a BORDA conta: o
   * `ref` começa no valor atual, então a primeira renderização não recarrega
   * nada (o hook já busca sozinho no mount) e uma lista que já está em dia não
   * gera requisição a cada render.
   */
  const onlineRef = useRef(online);
  useEffect(() => {
    if (online && !onlineRef.current) reloadList();
    onlineRef.current = online;
  }, [online, reloadList]);

  const onNewDelivery = useCallback(
    (newcomers) => {
      const first = newcomers[0];
      showToast(
        first.customerName ? `Novo pedido: ${first.customerName}` : "Novo pedido atribuído a você",
        "success"
      );
    },
    [showToast]
  );
  const { markSelfAction, clearSelfAction } = useNewDeliveryAlert({ deliveries: list, loading, onNewDelivery });

  async function mutate(kind, id) {
    setBusyId(id);
    // A recarga que vem a seguir é consequência do meu toque: a detecção de
    // "pedido novo" não pode tocar o som para quem acabou de agir. Marcado
    // ANTES do await — o toast do sucesso já re-renderiza, e é nesse render
    // que a lista nova entra na tela.
    markSelfAction();
    try {
      if (kind === "dispatch") {
        await dispatchDelivery(id);
        showToast("Saída registrada", "success");
      } else if (kind === "deliver") {
        await deliverDelivery(id);
        showToast("Entrega concluída", "success");
      } else {
        await failDelivery(id, reason.trim());
        showToast("Falha registrada", "info");
        setFailing(null);
        setReason("");
      }
      await reloadList();
    } catch (e) {
      // Nada mudou no servidor: o crédito volta, senão o próximo pedido de
      // verdade chega mudo.
      clearSelfAction();
      showToast(e?.message ?? "Não consegui registrar", "error");
    } finally {
      setBusyId(null);
    }
  }

  function openFail(delivery) {
    setFailing(delivery);
    setReason("");
  }

  function closeFail() {
    setFailing(null);
    setReason("");
  }

  // `error` do hook é OPCIONAL por contrato: enquanto o outro agente não o
  // entregar, `undefined` é o estado normal e o erro vem só do `reloadList`.
  const problem = error ?? loadError;

  /**
   * O que decide "esta tela tem trabalho" é a soma das SEÇÕES, nunca o
   * comprimento cru da lista: `delivered`/`cancelled` ainda podem voltar no
   * payload (o filtro é do hook) e, contados, eles deixavam a tela sem o
   * "tudo em dia" e sem nenhuma seção — três cabeçalhos vazios, que é a pior
   * tela possível depois de marcar a última entrega como entregue.
   */
  const workable = active.length + queue.length + failed.length;
  const showBlockingError = !loading && !!problem && workable === 0;
  const showStaleWarning = !loading && !!problem && workable > 0;

  const cardProps = { now, onDispatch: (id) => mutate("dispatch", id), onDeliver: (id) => mutate("deliver", id), onFail: openFail };

  return (
    // Sem `min-h-screen` aqui: a casca (`app/router.jsx`) já tem o `min-h-screen`
    // dela, e a repetição estourava a altura útil do celular — dois headers e
    // uma dobra de rolagem. O `100dvh - 3.5rem` desconta o header `h-14` da
    // casca para a coluna ter a altura da tela sem repetir o fundo.
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col bg-stone-950 text-stone-50">
      <Toast toast={toast} />

      {/* Cabeçalho de tela ENXUTO, e não o `ScreenHeader`. Motivo, medido:
          o `ScreenHeader` (`shared/components/ScreenHeader.jsx`) é feito para
          telas que abrem POR CIMA da casca (detalhe da comanda, lançar item) e
          traz `pt-[max(0.75rem,env(safe-area-inset-top))]` + `border-b`. Aqui
          logo abaixo já existe o header `h-14` da casca: o inset do notch já foi
          gasto por ele, então o do `ScreenHeader` empurraria o conteúdo ~44px
          para baixo sem proteger nada, e as duas `border-b` virariam uma linha
          dupla. Nesta tela a altura é o recurso escasso — o notch custa mais
          que um card compacto inteiro. Título com `font-display`, como o resto
          do app, e UMA linha só: a contagem que o subtítulo fazia ("2 na fila")
          já está no cabeçalho de cada seção abaixo, então o subtítulo era altura
          comprada sem informação nova. */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
        <h1 className="font-display text-xl font-bold leading-tight truncate min-w-0">Minhas entregas</h1>
        <button
          type="button"
          onClick={reloadList}
          aria-label="Atualizar entregas"
          className="w-11 h-11 -mr-2 shrink-0 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-100 transition-colors"
        >
          <RefreshCcw size={18} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* `max-w-2xl mx-auto` é a mesma contenção das abas do gerente
          (`pages/manager/tabs/*`): no celular ela não muda nada (o card é de
          largura toda, que é o que o polegar quer) e no desktop impede que o
          card hero vire uma faixa de 1400px — a linha de ação tem largura de
          polegar em qualquer tela. */}
      <div className="flex-1 w-full max-w-2xl mx-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-4">
        {!online && <OfflineBanner />}
        {showStaleWarning && <StaleWarning onRetry={reloadList} />}

        {loading && list.length === 0 && <CourierSkeleton />}

        {showBlockingError && <CourierError onRetry={reloadList} busy={loading} />}

        {!loading && workable === 0 && !showBlockingError && <CourierEmpty />}

        {workable > 0 && (
          <div className="space-y-5">
            {active.length > 0 && (
              <section aria-labelledby="courier-secao-em-rota">
                <h2
                  id="courier-secao-em-rota"
                  className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3"
                >
                  Em rota · {active.length}
                </h2>
                <div className="space-y-3">
                  <DeliveryCard
                    delivery={active[0]}
                    variant="hero"
                    busy={busyId === active[0].id}
                    {...cardProps}
                  />
                  {active.slice(1).map((d) => (
                    <DeliveryCard
                      key={d.id}
                      delivery={d}
                      variant="compact"
                      busy={busyId === d.id}
                      {...cardProps}
                    />
                  ))}
                </div>
              </section>
            )}

            <section aria-labelledby="courier-secao-fila">
              <h2
                id="courier-secao-fila"
                className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3"
              >
                Fila · {queue.length}
              </h2>
              {queue.length === 0 ? (
                <QueueEmpty />
              ) : (
                <div className="space-y-3">
                  {queue.map((d) => (
                    <DeliveryCard key={d.id} delivery={d} variant="queue" busy={busyId === d.id} {...cardProps} />
                  ))}
                </div>
              )}
            </section>

            {failed.length > 0 && (
              <section aria-labelledby="courier-secao-problemas">
                <h2
                  id="courier-secao-problemas"
                  className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3"
                >
                  Problemas · {failed.length}
                </h2>
                <div className="space-y-3">
                  {failed.map((d) => (
                    <FailedDeliveryCard key={d.id} delivery={d} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {failing && (
        <FailReasonModal
          delivery={failing}
          reason={reason}
          onChange={setReason}
          onClose={closeFail}
          onConfirm={() => mutate("fail", failing.id)}
          busy={busyId === failing.id}
        />
      )}
    </div>
  );
}