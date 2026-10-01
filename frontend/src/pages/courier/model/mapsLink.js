/**
 * Rota de navegação: deep link de mapa, sem lib, sem chave de API, sem GPS.
 *
 * A URL de busca do Google Maps abre o app de mapas nativo no Android (que
 * tem o pacote `com.google.android.apps.maps`) e o Apple Maps no iOS, e
 * funciona no desktop. `api=1` é a forma oficial de busca por texto: ponto por
 * coordenada seria `dir_action=navigate` e exigiria lat/long que a tela não tem.
 */
export function mapsUrl(address) {
  const query = String(address ?? "").trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}