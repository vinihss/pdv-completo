import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Os ícones padrão do Leaflet são referenciados por caminho relativo em CSS,
// o que quebra com qualquer bundler (o Vite resolve o CSS mas não o <img>).
// O conserto canônico: importar os PNGs como assets e apontar o Icon.Default
// para as URLs que o bundler gerou.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

export const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contribuidores';

// Centro padrão quando ainda não existe posição nenhuma (Brasil).
export const FALLBACK_CENTER = [-15.78, -47.88];
export const FALLBACK_ZOOM = 4;
export const STREET_ZOOM = 16;
