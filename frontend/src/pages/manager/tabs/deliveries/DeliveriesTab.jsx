import React, { useState } from "react";
import { RefreshCcw, AlertTriangle, X, MapPin, ChevronDown } from "lucide-react";
import {
  assignCourier,
  setDeliveryStatus,
  DeliveryStatusBadge,
  allowedTransitions,
  statusNeedsReason,
  isOpenDelivery,
} from "@/entities/delivery";
import { cancelOrder } from "@/entities/order";
import { useDeliveries } from "@/entities/delivery";
import { useOrderFocus } from "@/app/providers/order-focus";
import { formatDateTime, minutesSince } from "@/shared/lib";
import { ConfirmModal, inputClass } from "@/shared/components";

// Rótulo do pedido no card. O `orderId` é um uuid e o card só mostra os 8
// primeiros caracteres. A guarda existe porque o `orderId` é o elo com a
// comanda: `.slice()` direto derrubava o card inteiro quando ele faltava, e um
// card quebrado é pior que um card sem número.
function pedidoLabel(orderId) {
  return orderId ? `Pedido #${String(orderId).slice(0, 8)}` : "Pedido sem número";
}

// "parada há 23 min": quanto tempo a entrega está esperando ação. O cálculo cru
// (minutos desde o timestamp) é genérico e já vive em `shared/lib/format.js`
// (`minutesSince`); o TEXTO é vocabulário de entrega e mora aqui de propósito —
// `__tests__/fsd-boundaries.test.js` proíbe nome de domínio em `shared/*`, então
// um formatador genérico lá dentro passaria no teste e vazar o conceito.
function tempoParado(createdAt, now = Date.now()) {
  const min = minutesSince(createdAt, now);
  if (min < 1) return "parada há menos de 1 min";
  if (min < 60) return `parada há ${Math.floor(min)} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) {
    const resto = Math.floor(min % 60);
    return resto > 0 ? `parada há ${horas} h ${resto} min` : `parada há ${horas} h`;
  }
  const dias = Math.floor(horas / 24);
  return dias === 1 ? "parada há 1 dia" : `parada há ${dias} dias`;
}

// Ordem de trabalho da fila do balcão.
//
// O backend entrega `createdAt` DESCENDENTE — o que caiu por último vem
// primeiro (`docs/05-delivery-api-contracts.md:314`). Isso é o contrato
// documentado (e é o certo para o histórico e para a lista do entregador, que é
// o oposto), mas na tela do gerente vira o problema inverso: a entrega mais
// antiga e mais urgente cai no FIM da lista, fora da dobra do olho. Daí o resort
// ser CLIENT-SIDE: arrumar no servidor mudaria um contrato API por causa de uma
// tela, e as duas leituras são legítimas para consumidores diferentes.
// Custo: uma cópia da lista por render, sobre as entregas do dia.
const FILA_RANK = { awaiting_courier: 0, out_for_delivery: 1 };
const HISTORICO_RANK = 2;

function criadoEmMs(delivery) {
  const t = Date.parse(delivery?.createdAt ?? "");
  // Sem `createdAt` a entrega vira a mais antiga da fila: idade desconhecida é
  // o pior cenário para o gerente, então ela sobe.
  return Number.isNaN(t) ? 0 : t;
}

function ordenarPorUrgencia(lista) {
  return [...lista].sort((a, b) => {
    const ra = FILA_RANK[a?.status] ?? HISTORICO_RANK;
    const rb = FILA_RANK[b?.status] ?? HISTORICO_RANK;
    // Fila antes de histórico: quem ainda espera atendimento sobe.
    if (ra !== rb) return ra - rb;
    // No histórico a ordem do backend é a informativa ("o que caiu por
    // último"), e `sort` é estável — devolver empate já a preserva.
    if (ra === HISTORICO_RANK) return 0;
    // Dentro da fila, a mais antiga primeiro: é a que está esperando há mais
    // tempo e a que o gerente tem que resolver antes.
    return criadoEmMs(a) - criadoEmMs(b);
  });
}

export default function DeliveriesTab({ showToast }) {
  const { deliveries, couriers, loading, reload } = useDeliveries();
  const { focusOrder } = useOrderFocus();
  const [assigning, setAssigning] = useState(null); // deliveryId em progresso
  const [openReasonFor, setOpenReasonFor] = useState(null); // deliveryId com o campo de motivo aberto
  const [submitting, setSubmitting] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  // Entregues e canceladas saem da lista por padrão: a tela do balcão é fila
  // de trabalho, e uma entrega resolvida enterre a próxima atrás dela. O
  // toggle devolve o histórico sem precisar trocar de tela.
  const [showResolved, setShowResolved] = useState(false);
  // Troca de status em voo (deliveryId) e o pedido de motivo: guarda a
  // ENTREGA e o STATUS de destino juntos, porque o motivo pertence ao par —
  // com dois estados soltos, abrir o motivo da entrega A e depois da B
  // deixaria o campo apontando para a entrega errada.
  const [changingStatus, setChangingStatus] = useState(null);
  const [reasonFor, setReasonFor] = useState(null); // { id, status }
  // Entrega esperando a confirmação final do cancelamento (o objeto inteiro, e
  // não o id, porque o `ConfirmModal` precisa do `customerName` na mensagem).
  const [confirmCancelFor, setConfirmCancelFor] = useState(null);
  // O backend não devolve o status do pedido nessa lista (só o da entrega,
  // que fica "failed" pra sempre mesmo depois de cancelado) — rastreia
  // localmente pra não deixar cancelar de novo por engano na mesma sessão.
  const [justCancelled, setJustCancelled] = useState(() => new Set());

  const visible = ordenarPorUrgencia(showResolved ? deliveries : deliveries.filter(isOpenDelivery));

  async function handleAssign(deliveryId, courierId) {
    if (!courierId) return;
    setAssigning(deliveryId);
    try {
      await assignCourier(deliveryId, courierId);
      showToast("Entregador atribuído.", "success");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setAssigning(null);
    }
  }

  async function handleStatus(deliveryId, status, reason) {
    setChangingStatus(deliveryId);
    try {
      await setDeliveryStatus(deliveryId, status, reason);
      showToast(`Entrega ${status === "delivered" ? "concluída" : "atualizada"}.`, "success");
      setReasonFor(null);
      setCancelReason("");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setChangingStatus(null);
    }
  }

  async function handleCancel(delivery) {
    if (!cancelReason.trim() || submitting) return;
    setSubmitting(true);
    try {
      await cancelOrder(delivery.orderId, cancelReason.trim());
      showToast("Pedido cancelado.", "success");
      setJustCancelled((s) => new Set(s).add(delivery.id));
      setOpenReasonFor(null);
      setConfirmCancelFor(null);
      setCancelReason("");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  // Contadores sobre a lista EXIBIDA: com o histórico aberto, "3 aguardando"
  // precisa descrever as 3 que estão na tela, não só as pendentes.
  const awaitingCount = visible.filter((d) => d.status === "awaiting_courier").length;
  const outCount = visible.filter((d) => d.status === "out_for_delivery").length;
  // Este conta sobre `deliveries`, NÃO sobre `visible`: com o histórico ligado
  // `visible === deliveries` e a subtração virava 0, então o checkbox se
  // anunciava como "Mostrar entregues e canceladas (0)" bem com as entregues
  // abertas na tela. O número tem de descrever o que está ESCONDIDO, não a
  // diferença entre duas listas que já são iguais.
  const resolvedCount = deliveries.filter((d) => !isOpenDelivery(d)).length;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-4 text-sm text-stone-400">
        <span>{awaitingCount} aguardando</span>
        <span>{outCount} a caminho</span>
        <button onClick={reload} className="ml-auto flex items-center gap-1.5 text-stone-500 hover:text-stone-300">
          <RefreshCcw size={13} /> Atualizar
        </button>
      </div>

      {/* O toggle só aparece quando há o que revelar — com nada resolvido no
          histórico ele seria um controle morto na tela. */}
      {(resolvedCount > 0 || showResolved) && (
        <label className="flex items-center gap-2 text-xs text-stone-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="accent-amber-500 w-3.5 h-3.5"
          />
          Mostrar entregues e canceladas ({resolvedCount})
        </label>
      )}

      {loading && visible.length === 0 && <div className="text-stone-600 text-sm py-8 text-center">Carregando…</div>}
      {!loading && visible.length === 0 && (
        <div className="text-stone-600 text-sm py-8 text-center">
          {resolvedCount > 0
            ? "Nenhuma entrega pendente — todas as do período já foram concluídas ou canceladas."
            : "Nenhuma entrega no momento."}
        </div>
      )}

      <div className="space-y-2.5">
        {visible.map((d) => (
          <div
            key={d.id}
            role="button"
            tabIndex={0}
            data-testid="delivery-card"
            // O card é um button para leitor de tela, então o nome acessível
            // é a concatenação de tudo que está dentro — endereço, datas e o
            // select de atribuir. Um rótulo curto e útil vale mais que isso.
            aria-label={`Abrir comanda de ${d.customerName ?? "cliente sem nome"}`}
            onClick={() => focusOrder(d.orderId)}
            onKeyDown={(e) => {
              // `e.target !== e.currentTarget` porque o card tem controles
              // dentro (os <select> de atribuir e de status): sem isso, Espaço
              // no select fechava o dropdown e abria a comanda junto.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                focusOrder(d.orderId);
              }
            }}
            // `hover:bg-stone-800`, e não 850: a escala `stone` do Tailwind 4 é
            // numérica e para no 950 — não existe 850, e sem a classe no
            // `index.css` o hover do card simplesmente não acontecia.
            className="bg-stone-900 border border-stone-800 rounded-2xl p-4 cursor-pointer transition-colors hover:bg-stone-800 hover:border-stone-700 active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-stone-500">{pedidoLabel(d.orderId)}</p>
                <p className="text-sm font-semibold mt-0.5 truncate">{d.customerName ?? "— sem nome —"}</p>
                <div className="flex items-start gap-1.5 mt-1">
                  <MapPin size={12} className="mt-0.5 shrink-0 text-stone-500" />
                  <p className="text-xs text-stone-400 leading-snug">{d.address}</p>
                </div>
                <p className="text-xs text-stone-500 mt-1.5" data-testid="delivery-datetime">
                  {formatDateTime(d.createdAt)}
                  {/* "Parada há X" só faz sentido enquanto a entrega espera
                      ação — entregue e cancelado não estão parados, estão
                      encerrados (os dois saem da fila com `isOpenDelivery`). */}
                  {isOpenDelivery(d) && (
                    <span className="text-stone-400" data-testid="delivery-elapsed">
                      {" · "}
                      {tempoParado(d.createdAt)}
                    </span>
                  )}
                  {d.deliveredAt && (
                    <span className="text-emerald-400"> · Entregue {formatDateTime(d.deliveredAt)}</span>
                  )}
                </p>
              </div>
              <DeliveryStatusBadge status={d.status} className="shrink-0" />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              {d.status === "awaiting_courier" && !d.courier ? (
                <select
                  aria-label={`Atribuir entregador para ${d.customerName ?? "cliente sem nome"}`}
                  disabled={assigning === d.id}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handleAssign(d.id, e.target.value)}
                  defaultValue=""
                  className={inputClass + " max-w-[220px]"}
                >
                  <option value="" disabled>Atribuir entregador</option>
                  {couriers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-stone-400">{d.courier?.name ?? "— não atribuído —"}</span>
              )}

              <span className="text-xs text-stone-500 shrink-0">
                {d.status === "awaiting_courier" && d.courier && "Aguardando saída"}
                {d.status === "out_for_delivery" &&
                  d.dispatchedAt &&
                  `Saiu às ${new Date(d.dispatchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
              </span>
            </div>

            {/* Correção de status pelo balcão. Só o gerente chega aqui (a rota
                é `requireRole("manager")`), e o <select> oferece apenas as
                transições válidas a partir do status atual — mandar todos os
                status faria o gerente descobrir a regra por erro do servidor,
                uma tentativa por vez. `delivered`/`cancelled` são terminais e
                não renderizam controle nenhum. */}
            {allowedTransitions(d.status).length > 0 && (
              <div
                className="mt-2.5 pt-2.5 border-t border-stone-800"
                onClick={(e) => e.stopPropagation()}
              >
                {reasonFor?.id === d.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder={reasonFor.status === "failed" ? "Motivo da falha" : "Motivo do cancelamento"}
                      className={inputClass + " flex-1"}
                    />
                    <button
                      onClick={() => handleStatus(d.id, reasonFor.status, cancelReason.trim())}
                      disabled={!cancelReason.trim() || changingStatus === d.id}
                      className="bg-amber-500 text-stone-950 px-3 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={() => { setReasonFor(null); setCancelReason(""); }}
                      className="px-2 rounded-lg border border-stone-700 text-xs"
                      aria-label="Cancelar edição de status"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-stone-500 shrink-0">Status</label>
                    <div className="relative flex-1">
                      <select
                        disabled={changingStatus === d.id}
                        value=""
                        onChange={(e) => {
                          const next = e.target.value;
                          if (!next) return;
                          // Cancelar e falhar guardam o texto que o cliente
                          // recebe na notificação: sem motivo, não vai.
                          if (statusNeedsReason(next)) {
                            setCancelReason("");
                            setReasonFor({ id: d.id, status: next });
                            return;
                          }
                          handleStatus(d.id, next);
                        }}
                        aria-label={`Alterar status da entrega de ${d.customerName ?? "cliente"}`}
                        className={`${inputClass} appearance-none pr-8 ${
                          changingStatus === d.id ? "opacity-50" : ""
                        }`}
                      >
                        <option value="">Alterar status…</option>
                        {allowedTransitions(d.status).map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <ChevronDown
                        size={13}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 pointer-events-none"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {d.status === "failed" && (
              <div className="mt-2 pt-2 border-t border-stone-800" onClick={(e) => e.stopPropagation()}>
                <p className="text-xs text-red-400 mb-2">Motivo da falha: {d.notes}</p>
                {justCancelled.has(d.id) ? (
                  <p className="text-xs text-stone-500">Pedido cancelado.</p>
                ) : openReasonFor === d.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Motivo do cancelamento"
                      className={inputClass + " flex-1"}
                    />
                    <button
                      // Este botão só ARMA a confirmação: cancelar pedido é
                      // irreversível e o cliente é avisado por WhatsApp, então
                      // o clique precisa de um segundo ponto de decisão. Com o
                      // motivo já digitado, era um clique de distância do erro.
                      onClick={() => setConfirmCancelFor(d)}
                      disabled={!cancelReason.trim() || submitting}
                      className="bg-red-600 text-white px-3 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      Revisar cancelamento
                    </button>
                    <button
                      onClick={() => { setOpenReasonFor(null); setCancelReason(""); }}
                      className="px-2 rounded-lg border border-stone-700 text-xs"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setOpenReasonFor(d.id); setCancelReason(d.notes ?? ""); }}
                    className="text-xs font-semibold text-red-400 border border-red-900 rounded-lg px-2.5 py-1.5"
                  >
                    Cancelar pedido
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {couriers.length === 0 && !loading && (
        <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
          <AlertTriangle size={14} /> Nenhum entregador cadastrado — crie um usuário com papel "courier" em Equipe.
        </div>
      )}

      {/* Confirmação do cancelamento. O dono da sobreposição é o `ConfirmModal`
          (docs/agent-frontend.md §ConfirmModal) — nada de overlay ad-hoc. E
          fica FORA do card de propósito: renderizado dentro dele, o clique do
          backdrop borbulharia para o `onClick` do card e abriria a comanda em
          vez de confirmar o cancelamento. */}
      {confirmCancelFor && (
        <ConfirmModal
          title="Cancelar pedido?"
          message={`O pedido de ${confirmCancelFor.customerName ?? "cliente sem nome"} será cancelado e o cliente avisado: "${cancelReason.trim()}". Não dá para desfazer.`}
          confirmLabel={submitting ? "Cancelando…" : "Sim, cancelar pedido"}
          destructive
          onCancel={() => setConfirmCancelFor(null)}
          onConfirm={() => handleCancel(confirmCancelFor)}
        />
      )}
    </div>
  );
}