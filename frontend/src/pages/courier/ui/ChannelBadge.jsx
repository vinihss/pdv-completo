import React from "react";
import { Globe, MessageCircle, Store } from "lucide-react";

/**
 * Canal do pedido. Campo opcional do payload (`whatsapp` | `web` | `ifood`) —
 * sem ele a linha simplesmente não aparece.
 *
 * `DeliveryStatusBadge` (entidade) é o badge de ESTADO; este é o de ORIGEM do
 * pedido, que responde "de onde veio o que eu tô entregando". Canais que
 * chegam depois do contrato caem em "Outro" pelo texto cru, nunca quebram o
 * card.
 */
const CHANNEL_VIEW = {
  whatsapp: { label: "WhatsApp", Icon: MessageCircle, className: "text-emerald-400" },
  web: { label: "Site", Icon: Globe, className: "text-sky-400" },
  ifood: { label: "iFood", Icon: Store, className: "text-red-400" },
};

export default function ChannelBadge({ channel }) {
  const view = CHANNEL_VIEW[channel];
  if (!channel) return null;
  const { label, Icon, className } = view ?? { label: String(channel), Icon: Globe, className: "text-stone-400" };

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${className}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}