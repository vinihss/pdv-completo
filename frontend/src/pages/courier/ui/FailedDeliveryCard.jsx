import React from "react";
import { MapPin } from "lucide-react";
import { DeliveryStatusBadge } from "@/entities/delivery";
import { shortOrderId } from "../model/orderView.js";

/**
 * Entrega com problema: a tela do entregador NÃO some com ela (bug antigo —
 * o endpoint filtrava e ela sumia assim que ele marcava falha) e o gerente
 * assume a partir daqui.
 *
 * O card é deliberadamente CALMO: nenhuma ação, nada vermelho pulsando, nada
 * pedindo um toque. Quem marcou a falha já cumpriu o papel dele — gritar na
 * tela dele só diria "você errou", e a mensagem que importa é outra: isso aqui
 * já tem dono, o gerente. Por isso o tom é o mesmo da fila (`stone`), e só o
 * badge de status (que é da entidade, compartilhado com o balcão) carrega a
 * informação de que o pedido parou.
 *
 * Mostrar o motivo (`notes` é o texto que o `failDeliveryUsecase` grava) é o
 * que permite ao gerente entender sem perguntar nada — e confirma ao
 * entregador que o texto que ele escolheu no modal foi o que ficou registrado.
 */
export default function FailedDeliveryCard({ delivery }) {
  const address = delivery.address ?? "";
  const orderRef = shortOrderId(delivery.orderId);
  const reason = String(delivery.notes ?? "").trim();

  return (
    <article
      data-testid="delivery-card-failed"
      className="rounded-2xl border border-stone-700/60 bg-stone-900/40 p-3.5"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-bold leading-tight truncate">
            {delivery.customerName ?? "Cliente sem nome"}
          </p>
          {orderRef && <p className="text-xs text-stone-500 mt-0.5">{orderRef}</p>}
        </div>
        <DeliveryStatusBadge status={delivery.status} className="shrink-0 whitespace-nowrap" />
      </header>

      {address && (
        <div className="mt-2 flex items-start gap-1.5">
          <MapPin size={14} className="mt-0.5 shrink-0 text-stone-600" />
          <p className="text-sm text-stone-500 leading-snug">{address}</p>
        </div>
      )}

      {reason && (
        <p className="mt-2 text-sm text-stone-300">
          <span className="text-stone-500">Motivo: </span>
          {reason}
        </p>
      )}

      <p className="mt-2.5 pt-2.5 border-t border-stone-800/70 text-xs text-stone-400">
        Problema na entrega — o gerente vai resolver
      </p>
    </article>
  );
}