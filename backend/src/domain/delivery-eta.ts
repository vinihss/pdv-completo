/**
 * Previsão de entrega do checkout público (/pedido).
 *
 * Modelo deliberadamente simples, sem API externa. Não chamamos Nominatim nem
 * OSRM no caminho do pedido: dependência de terceiro dentro de uma escrita
 * derruba o checkout quando o serviço cai, e o /pedido é justamente o fluxo que
 * não pode cair. A distância real do cliente também não é conhecida no intake —
 * só o endereço — então a estimativa sai da MESMA tabela que já decide o frete,
 * `store_settings.delivery_fee_tiers` (a última faixa é o raio de entrega, ver
 * SettingsTab). O cliente escolhe a faixa aproximada na tela de endereço e a
 * faixa devolve `maxKm`, que vira tempo de viagem.
 *
 *     minutos = preparo (delivery_prep_minutes)
 *             + viagem (max(5, maxKm da faixa * minutes_per_km))
 *
 * O `maxKm` escolhido e o total são gravados em `delivery.distance_km` e
 * `delivery.estimated_minutes` — as duas colunas existem desde a migration 0001
 * e nunca eram escritas por nada. Assim o manager e o entregador enxergam a
 * mesma promessa que o cliente fez, e quando a distância real entrar via OSRM o
 * lugar de sobrescrever já está reservado.
 *
 * A estimativa é um ponto, mas a tela mostra uma janela: `estimateWindow` abre
 * ±20% arredondado para 5. Cozinha quase sempre entrega no mesmo cluster e um
 * número exato ("38 min") é uma promessa que o balcão não consegue cumprir.
 */

export interface DeliveryEtaInput {
  /** `maxKm` da faixa de frete escolhida. null = cliente não informou faixa. */
  maxKm: number | null;
  /** `store_settings.delivery_prep_minutes`. */
  prepMinutes: number;
  /** `store_settings.minutes_per_km`. */
  minutesPerKm: number;
}

/** Piso da viagem: mesmo "na esquina" o entregador precisa montar a mochila. */
const MIN_TRAVEL_MINUTES = 5;

/** Teto: acima disso a previsão vira ruído e ninguém acerta. */
const MAX_ETA_MINUTES = 180;

export function estimateDeliveryMinutes(input: DeliveryEtaInput): number {
  const prep = Math.max(0, Math.round(input.prepMinutes));
  const km = input.maxKm === null ? 0 : Math.max(0, input.maxKm);
  const travel = Math.max(MIN_TRAVEL_MINUTES, Math.ceil(km * Math.max(0, input.minutesPerKm)));
  return Math.min(MAX_ETA_MINUTES, prep + travel);
}

/**
 * Janela que a tela de acompanhamento mostra: mesma base do ponto, com folga de
 * 20% para os dois lados e arredondamento para 5. O cliente vê "40 a 50 min" em
 * vez de um número que ele pode cobrar na boca do entregador.
 */
export function estimateWindow(estimatedMinutes: number): { min: number; max: number } {
  const base = Math.max(1, Math.round(estimatedMinutes));
  const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  return { min: round5(base * 0.8), max: round5(base * 1.2) };
}

/**
 * Minutos de viagem que ainda faltam, do ponto de vista de um stage.
 *
 * Antes de sair para entrega o cliente está esperando preparo + viagem, então a
 * janela não muda: o que muda é a BASE. Depois do despacho a cozinha já entregou
 * e sobra só o trajeto — é quando a previsão deixa de ser estimativa e passa a
 * ser contagem regressiva do `dispatched_at`.
 */
export function remainingMinutes(input: { estimatedMinutes: number; travelMinutes: number | null }): number {
  return Math.max(0, input.travelMinutes ?? input.estimatedMinutes);
}
