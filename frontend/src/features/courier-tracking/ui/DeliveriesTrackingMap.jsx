import React from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { MapPinOff } from "lucide-react";
import { FALLBACK_CENTER, FALLBACK_ZOOM, OSM_ATTRIBUTION, OSM_TILES } from "./mapSetup.js";

function formatHora(updatedAt) {
  const d = updatedAt ? new Date(updatedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return "horário desconhecido";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mapa de acompanhamento da aba Entregas do gerente: um marker por
 * entregador com entrega em rota, alimentado pela carga inicial +
 * `courier.location` em tempo real (ver `useDeliveryLocations`).
 *
 * Sem posição conhecida ainda (ninguém despachou, ou o entregador não
 * liberou o GPS), mostra o estado vazio honesto em vez de um mapa do
 * Brasil inteiro sem marker nenhum.
 */
export default function DeliveriesTrackingMap({ locations, loaded }) {
  const points = (locations ?? []).filter((l) => l?.latitude != null && l?.longitude != null);

  if (points.length === 0) {
    return (
      <div
        data-testid="deliveries-map-empty"
        className="flex items-center gap-2 rounded-xl border border-stone-800 bg-stone-900 px-3 py-2.5 text-xs text-stone-500"
      >
        <MapPinOff size={14} className="shrink-0" />
        {loaded ? "Sem localização do entregador ainda." : "Carregando localizações…"}
      </div>
    );
  }

  const center =
    points.length === 1 ? [points[0].latitude, points[0].longitude] : FALLBACK_CENTER;

  return (
    <div
      data-testid="deliveries-tracking-map"
      className="overflow-hidden rounded-xl border border-stone-800"
    >
      <MapContainer
        center={center}
        zoom={points.length === 1 ? 13 : FALLBACK_ZOOM}
        className="h-64 w-full"
        scrollWheelZoom={false}
        bounds={points.length > 1 ? points.map((p) => [p.latitude, p.longitude]) : undefined}
        boundsOptions={{ padding: [40, 40] }}
      >
        <TileLayer url={OSM_TILES} attribution={OSM_ATTRIBUTION} />
        {points.map((p) => (
          <Marker key={p.courierId} position={[p.latitude, p.longitude]}>
            <Popup>
              <strong>{p.courierName ?? "Entregador"}</strong>
              <br />
              Atualizado às {formatHora(p.updatedAt)}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
