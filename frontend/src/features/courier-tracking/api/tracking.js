import { request } from "@/shared/api/http";

// ---------- Rastreamento do entregador ----------

// Ping de GPS do app do entregador. O backend só aceita enquanto houver
// entrega `out_for_delivery` para o courier autenticado; quem chama já
// garante isso (o hook só liga com entrega em rota), então um 4xx aqui é
// corrida de status (a entrega foi concluída entre o render e o tick) e não
// erro de verdade — o chamador engole.
export function postCourierLocation({ latitude, longitude, accuracy }) {
  return request("POST", "/courier/location", {
    latitude,
    longitude,
    ...(accuracy != null ? { accuracy } : {}),
  });
}

// Posições mais recentes dos entregadores com entrega em rota (visão do
// gerente). Carga inicial do mapa; daí em diante quem atualiza é o evento
// realtime `courier.location` na room `deliveries`.
export function listDeliveryLocations() {
  return request("GET", "/manager/deliveries/locations");
}
