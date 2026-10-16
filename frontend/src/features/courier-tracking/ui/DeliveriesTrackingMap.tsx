import { MapPinOff } from "lucide-react";
import React from "react";
import { CircleMarker, MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { FALLBACK_CENTER, FALLBACK_ZOOM, OSM_ATTRIBUTION, OSM_TILES } from "./mapSetup.js";

// Cor do destino (pedido). Vermelho da paleta do Tailwind (red-600), o mesmo
// tom do badge de erro — no mapa, o que é do cliente não pode se confundir com
// o ponto azul do entregador.
const ORDER_COLOR = "#dc2626";

function formatHora(updatedAt) {
  const d = updatedAt ? new Date(updatedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return "horário desconhecido";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// Rótulo do pedido no popup, espelhando o do card do balcão: o `orderId` é um
// uuid e mostrar os 8 primeiros é o que liga o marker à comanda. Sem ele, diz
// "Pedido sem número" em vez de sumir.
function pedidoLabel(orderId) {
  return orderId ? `Pedido #${String(orderId).slice(0, 8)}` : "Pedido sem número";
}

/**
 * Mapa de acompanhamento da aba Entregas do gerente: um marker por entregador
 * em rota (posição alimentada pela carga inicial + `courier.location` em tempo
 * real, ver `useDeliveryLocations`) e um ponto por pedido com destino
 * georreferenciado (`addressLatitude`/`addressLongitude`, vindos do endereço
 * padrão do cliente na própria listagem — sem GET extra).
 *
 * Sem posição conhecida ainda (ninguém despachou, o entregador não liberou o
 * GPS, ou o pedido não tem endereço geocode), mostra o estado vazio honesto em
 * vez de um mapa do Brasil inteiro sem marker nenhum.
 */
export default function DeliveriesTrackingMap({ locations, deliveries, loaded }) {
  const couriers = (locations ?? []).filter(
    (l) => l?.latitude != null && l?.longitude != null,
  );
  const orders = (deliveries ?? []).filter(
    (d) => d?.addressLatitude != null && d?.addressLongitude != null,
  );

  if (couriers.length === 0 && orders.length === 0) {
    return (
      <div
        data-testid="deliveries-map-empty"
        className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs text-text-muted"
      >
        <MapPinOff size={14} className="shrink-0" />
        {loaded ? "Sem localização de entregador ou pedido ainda." : "Carregando localizações…"}
      </div>
    );
  }

  // O enquadramento tem que cobrir os dois conjuntos: um marker de motoboy
  // longe do ponto do pedido não pode ficar fora da tela.
  const points = [
    ...couriers.map((c) => [c.latitude, c.longitude]),
    ...orders.map((o) => [o.addressLatitude, o.addressLongitude]),
  ];
  const center = points.length === 1 ? points[0] : FALLBACK_CENTER;

  return (
    <div
      data-testid="deliveries-tracking-map"
      className="overflow-hidden rounded-xl border border-border"
    >
      <MapContainer
        center={center}
        zoom={points.length === 1 ? 13 : FALLBACK_ZOOM}
        className="h-64 w-full"
        scrollWheelZoom={false}
        bounds={points.length > 1 ? points : undefined}
        boundsOptions={{ padding: [40, 40] }}
      >
        <TileLayer url={OSM_TILES} attribution={OSM_ATTRIBUTION} />
        {couriers.map((c) => (
          <Marker key={`courier-${c.courierId}`} position={[c.latitude, c.longitude]}>
            <Popup>
              <strong>{c.courierName ?? "Entregador"}</strong>
              <br />
              Atualizado às {formatHora(c.updatedAt)}
            </Popup>
          </Marker>
        ))}
        {orders.map((o) => (
          <CircleMarker
            key={`order-${o.id}`}
            center={[o.addressLatitude, o.addressLongitude]}
            radius={8}
            pathOptions={{ color: ORDER_COLOR, fillColor: ORDER_COLOR, fillOpacity: 0.6 }}
          >
            <Popup>
              <strong>{o.customerName ?? "Cliente"}</strong>
              <br />
              {pedidoLabel(o.orderId)}
              {o.address ? (
                <>
                  <br />
                  {o.address}
                </>
              ) : null}
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
