import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw";
// @ts-ignore o frontend usa JS e não declara tipos do cliente HTTP compartilhado.
import { request } from "../../shared/api/http.js";
import "./delivery-map.css";

type Coordinate = { latitude: number; longitude: number };
type Region = { id: string; name: string; geometry: GeoJSON.Polygon };
type Delivery = { id: string; label?: string; coordinate?: Coordinate | null; latitude?: number; longitude?: number };
type Courier = { id: string; name?: string; latitude: number; longitude: number };
type Route = { type?: "LineString"; coordinates: [number, number][] };

type Props = {
  regions?: Region[];
  deliveries?: Delivery[];
  couriers?: Courier[];
  route?: Route | null;
  center?: [number, number];
  zoom?: number;
  onRegionSaved?: (region: Region) => void;
  tilesUrl?: string;
};

const DEFAULT_TILES = import.meta.env.VITE_MAP_TILES_URL ?? "http://localhost:8080/tile/{z}/{x}/{y}.png";
const DEFAULT_CENTER: [number, number] = [-23.55, -46.63];

/** Painel geográfico do gerente. GeoJSON e coordenadas seguem ordem RFC 7946: [longitude, latitude]. */
export function DeliveryMap({ regions, deliveries = [], couriers = [], route, center = DEFAULT_CENTER, zoom = 12, onRegionSaved, tilesUrl = DEFAULT_TILES }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const drawn = useRef<L.FeatureGroup | null>(null);
  const [error, setError] = useState("");
  const [loadedRegions, setLoadedRegions] = useState<Region[]>([]);
  const savedCallback = useRef(onRegionSaved);
  savedCallback.current = onRegionSaved;

  useEffect(() => {
    if (!host.current || map.current) return;
    const instance = L.map(host.current).setView(center, zoom);
    L.tileLayer(tilesUrl, { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(instance);
    const editable = L.featureGroup().addTo(instance);
    drawn.current = editable;
    new L.Control.Draw({ draw: { polygon: { allowIntersection: false, showArea: true }, polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false }, edit: { featureGroup: editable } }).addTo(instance);
    instance.on(L.Draw.Event.CREATED, async (rawEvent: L.LeafletEvent) => {
      const event = rawEvent as L.DrawEvents.Created;
      const layer = event.layer as L.Polygon;
      editable.addLayer(layer);
      const feature = layer.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>;
      const title = window.prompt("Nome da região de entrega:")?.trim();
      if (!title) { editable.removeLayer(layer); return; }
      try {
        setError("");
        const saved = await request("POST", "/delivery-regions", { name: title, geometry: feature.geometry }) as Region;
        setLoadedRegions((current) => [...current.filter((region) => region.id !== saved.id), saved]);
        savedCallback.current?.(saved);
      } catch (cause) {
        editable.removeLayer(layer);
        setError(cause instanceof Error ? cause.message : "Não foi possível salvar a região");
      }
    });
    map.current = instance;
    const resize = () => instance.invalidateSize();
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); instance.remove(); map.current = null; drawn.current = null; };
  }, [center, zoom, tilesUrl]);

  useEffect(() => {
    if (regions !== undefined) return;
    request("GET", "/delivery-regions").then((result: unknown) => setLoadedRegions(result as Region[]))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar as regiões"));
  }, [regions]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const overlays: L.Layer[] = [];
    for (const region of regions ?? loadedRegions) {
      overlays.push(L.geoJSON(region.geometry, { style: { color: "#0f766e", weight: 2, fillOpacity: 0.12 } }).bindTooltip(region.name));
    }
    for (const courier of couriers) {
      overlays.push(L.marker([courier.latitude, courier.longitude]).bindTooltip(courier.name ?? `Entregador ${courier.id}`));
    }
    for (const delivery of deliveries) {
      const latitude = delivery.coordinate?.latitude ?? delivery.latitude;
      const longitude = delivery.coordinate?.longitude ?? delivery.longitude;
      if (latitude == null || longitude == null) continue;
      overlays.push(L.circleMarker([latitude, longitude], { radius: 7, color: "#b45309", fillOpacity: 0.9 }).bindTooltip(delivery.label ?? `Entrega ${delivery.id}`));
    }
    if (route?.coordinates?.length) {
      overlays.push(L.polyline(route.coordinates.map(([longitude, latitude]) => [latitude, longitude] as L.LatLngTuple), { color: "#2563eb", weight: 5, opacity: 0.85 }));
    }
    overlays.forEach((layer) => layer.addTo(instance));
    return () => overlays.forEach((layer) => instance.removeLayer(layer));
  }, [regions, loadedRegions, deliveries, couriers, route]);

  return <section className="delivery-map-panel" aria-label="Mapa de regiões e entregas">
    <div ref={host} className="delivery-map" />
    <p className="delivery-map-attribution">© OpenStreetMap contributors</p>
    {error && <p className="delivery-map-error" role="alert">{error}</p>}
  </section>;
}

export default DeliveryMap;
