import React from "react";
import { AlertTriangle, Check, Clock, MapPin, MapPinned, Navigation, Phone, Timer } from "lucide-react";
import { DeliveryStatusBadge } from "@/entities/delivery";
import { digitsOnly, maskPhone } from "@/shared/lib";
import { mapsUrl } from "../model/mapsLink.js";
import { elapsedInfo } from "../model/elapsed.js";
import { estimatedText, orderLines, shortOrderId } from "../model/orderView.js";
import ChannelBadge from "./ChannelBadge.jsx";

/**
 * Card de entrega do entregador — três variantes, um só componente.
 *
 * `hero` é a entrega em rota (a próxima parada): card grande, ação primária de
 * 56px, que é alcance de polegar com o celular numa mão só. `compact` é a
 * sobra de quem tem duas em trânsito ao mesmo tempo. `queue` é a fila de
 * quem ainda não saiu — mesma anatomia, hierarquia menor.
 *
 * Hierarquia de ações (decisão de produto já validada, `docs/04-delivery-
 * self-service-integration.md` §Mockups: "card do entregador com no máximo 2
 * ações visíveis por entrega"): a linha de ação tem exatamente DOIS botões —
 * o que resolve a entrega (Rota / Entreguei) e o que muda o estado (Saí para
 * entrega). A rota e o telefone são links de DADO (abrem outro app, não mudam
 * o pedido) e ficam na linha de endereço; registrar problema é o caminho de
 * exceção, em faixa própria abaixo, discreta por definição — quem está com
 * luva e sol não deveria tropeçar nele, mas precisa chegar nele em 1 toque.
 */
export default function DeliveryCard({
  delivery,
  variant = "queue",
  now,
  busy = false,
  onDispatch,
  onDeliver,
  onFail,
}) {
  const hero = variant === "hero";
  const address = delivery.address ?? "";
  const route = mapsUrl(address);
  const name = delivery.customerName ?? "Cliente sem nome";
  const elapsed = elapsedInfo(delivery, now);
  const estimate = estimatedText(delivery.estimatedMinutes);
  const lines = orderLines(delivery);
  const phone = digitsOnly(delivery.customerPhone);
  const orderRef = shortOrderId(delivery.orderId);
  const actionHeight = hero ? "h-14" : "h-12";

  return (
    <article
      data-testid={`delivery-card-${variant}`}
      className={`rounded-2xl border transition-colors ${
        hero
          ? "bg-stone-900 border-sky-500/40 p-4 shadow-lg shadow-black/20"
          : "bg-stone-900 border-stone-800 p-3.5"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`font-display font-bold leading-tight truncate ${hero ? "text-lg" : "text-base"}`}>
            {name}
          </h2>
          {/* Só o que existe: sem `orderId` a linha some, sem canal não sobra
              um separador órfão. */}
          {(orderRef || delivery.channel) && (
            <p className="mt-0.5 flex items-center gap-2 text-xs text-stone-500 min-w-0">
              {orderRef && <span className="truncate">{orderRef}</span>}
              <ChannelBadge channel={delivery.channel} />
            </p>
          )}
        </div>
        <DeliveryStatusBadge status={delivery.status} className="shrink-0 whitespace-nowrap" />
      </header>

      <div className="mt-2 flex items-start gap-1.5">
        <MapPin size={hero ? 16 : 14} className="mt-0.5 shrink-0 text-amber-500" />
        <p className={`font-semibold leading-snug ${hero ? "text-base" : "text-sm"}`}>
          {address || <span className="text-stone-500 font-normal">Endereço não informado</span>}
        </p>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        {elapsed && (
          <span
            data-testid="delivery-elapsed"
            className={
              elapsed.urgent
                ? "inline-flex items-center gap-1 rounded-full border border-red-500/40 px-1.5 py-0.5 font-bold text-red-400 urgent-pulse"
                : "inline-flex items-center gap-1 text-stone-500"
            }
          >
            <Clock size={elapsed.urgent ? 12 : 11} />
            {elapsed.text}
          </span>
        )}
        {estimate && (
          <span className="inline-flex items-center gap-1 text-stone-500">
            <Timer size={11} />
            {estimate}
          </span>
        )}
        {phone && (
          <a
            href={`tel:${phone}`}
            aria-label={`Ligar para ${name}`}
            className="inline-flex items-center gap-1 text-stone-400 hover:text-amber-400"
          >
            <Phone size={11} />
            {maskPhone(delivery.customerPhone)}
          </a>
        )}
      </div>

      {/* Itens e observações do pedido: "sem cebola" em amarelo é o que evita
          o pedido voltar. Só aparece quando o payload trouxer. */}
      {lines.length > 0 && (
        <ul className="mt-2.5 pt-2.5 border-t border-stone-800 space-y-0.5">
          {lines.map((line) => (
            <li key={line} className="text-xs font-semibold text-amber-300/90 leading-snug">
              {line}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3.5 flex items-center gap-2.5">
        {route && (
          <a
            href={route}
            target="_blank"
            rel="noreferrer"
            aria-label={`Abrir rota para ${name} no mapa`}
            className={`${actionHeight} shrink-0 px-4 rounded-xl border border-stone-700 text-stone-300 hover:text-stone-100 flex items-center gap-2 text-sm font-semibold`}
          >
            <MapPinned size={18} />
            Rota
          </a>
        )}

        {variant === "queue" ? (
          <button
            type="button"
            onClick={() => onDispatch(delivery.id)}
            disabled={busy}
            aria-busy={busy}
            className={`${actionHeight} flex-1 rounded-xl bg-amber-500 text-stone-950 font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]`}
          >
            <Navigation size={18} />
            Saí para entrega
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDeliver(delivery.id)}
            disabled={busy}
            aria-busy={busy}
            className={`${actionHeight} flex-1 rounded-xl bg-amber-500 text-stone-950 font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] ${
              hero ? "text-base" : "text-sm"
            }`}
          >
            <Check size={hero ? 20 : 18} strokeWidth={2.5} />
            Entreguei
          </button>
        )}
      </div>

      {/* Caminho de exceção: uma faixa só, sem ícone de erro grande. Registrar
          problema abre o modal com os motivos em 1 toque — não um menu.
          Só na entrega EM TRÂNSITO: a máquina de status recusa `fail` a partir
          de `awaiting_courier` (409 "não está em trânsito"), então mostrar o
          botão na fila seria um convite a um erro. */}
      {variant !== "queue" && (
        <button
          type="button"
          onClick={() => onFail(delivery)}
          disabled={busy}
          className="mt-2 w-full h-11 rounded-xl border border-stone-800 text-stone-400 hover:text-stone-200 flex items-center justify-center gap-2 text-sm font-semibold disabled:opacity-50"
        >
          <AlertTriangle size={15} />
          Problema na entrega
        </button>
      )}
    </article>
  );
}