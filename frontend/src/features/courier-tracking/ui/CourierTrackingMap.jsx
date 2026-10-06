import React, { useEffect } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import { MapPinOff } from "lucide-react";
import { FALLBACK_CENTER, FALLBACK_ZOOM, OSM_ATTRIBUTION, OSM_TILES, STREET_ZOOM } from "./mapSetup.js";

/** Recentraliza o mapa quando a posição muda (o ping atualiza a cada 60s). */
function FollowMarker({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.setView(center, Math.max(map.getZoom(), STREET_ZOOM));
  }, [map, center]);
  return null;
}

/**
 * Mapa da entrega em rota, no app do entregador: marker da posição atual
 * (alimentada pelo ping de GPS local) e, se a entrega expuser
 * `addressLatitude`/`addressLongitude`, marker do destino. Sem posição
 * ainda, mostra o estado de espera em vez de um mapa do mundo inteiro —
 * um cinza com aviso é mais útil na rua que tiles carregando à toa.
 */
export default function CourierTrackingMap({ position, destination, permissionDenied, supported }) {
  if (permissionDenied || !supported) {
    return (
      <div
        data-testid="courier-map-gps-off"
        className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300"
      >
        <MapPinOff size={14} className="shrink-0" />
        Ative a localização para compartilhar sua posição.
      </div>
    );
  }

  const center = position ? [position.latitude, position.longitude] : FALLBACK_CENTER;
  const dest =
    destination?.latitude != null && destination?.longitude != null
      ? [destination.latitude, destination.longitude]
      : null;

  return (
    <div className="overflow-hidden rounded-xl border border-stone-800" data-testid="courier-tracking-map">
      <MapContainer
        center={center}
        zoom={position ? STREET_ZOOM : FALLBACK_ZOOM}
        className="h-56 w-full"
        scrollWheelZoom={false}
      >
        <TileLayer url={OSM_TILES} attribution={OSM_ATTRIBUTION} />
        {position && <FollowMarker center={center} />}
        {position && (
          <Marker position={center}>
            <Popup>Sua posição</Popup>
          </Marker>
        )}
        {dest && (
          <Marker position={dest}>
            <Popup>Endereço de entrega</Popup>
          </Marker>
        )}
      </MapContainer>
      {!position && (
        <p className="px-3 py-2 text-xs text-stone-500">Aguardando sinal de GPS…</p>
      )}
    </div>
  );
}
