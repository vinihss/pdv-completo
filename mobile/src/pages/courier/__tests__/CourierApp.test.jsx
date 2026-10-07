import React from "react";
import { cleanup, render } from "@testing-library/react-native";
import CourierApp from "../CourierApp";

// A fatia de página é server-authoritative e injeta state via hooks — o teste
// substitui os dados e exige apenas que a tela reaja ao que recebeu. Os hooks
// de ambiente (auth, gps, online) são mock: nada de rede nem de sensor real.
jest.mock("@/entities/delivery", () => ({
  useDeliveries: jest.fn(),
  dispatchDelivery: jest.fn(),
  deliverDelivery: jest.fn(),
  failDelivery: jest.fn(),
}));

jest.mock("@/features/courier-tracking", () => ({
  CourierTrackingMap: () => null,
  useCourierLocationPing: () => ({ position: null, permissionDenied: false, supported: true }),
}));

jest.mock("@/shared/hooks/useOnlineStatus", () => ({ useOnlineStatus: jest.fn(() => true) }));
jest.mock("@/shared/hooks/useAppStateActive", () => ({ useAppStateActive: jest.fn(() => {}) }));

// O hook real de alerta de nova entrega roda aqui de verdade — o que se mocka
// é a FOLHA (entities/alert): com ela fake, o `isAlertSoundEnabled()` síncrono
// e o áudio nunca tocam de verdade e o expo-audio nem carrega. Mockar o próprio
// useNewDeliveryAlert (como antes) esconderia justamente o contrato que interessa:
// "desligar o som não pode virar Promise invisível".
jest.mock("@/entities/alert", () => ({
  playAlertSound: jest.fn(() => Promise.resolve(true)),
  isAlertSoundEnabled: jest.fn(() => true),
}));

jest.mock("../model/useScreenWakeLock", () => ({ useScreenWakeLock: jest.fn() }));

// Ícones quebram renders repetidos sob o renderer assíncrono do RNTL v14.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = (props) => React.createElement(Text, null, props.name ?? "icon");
  return { Ionicons: Icon, __esModule: true };
});

const { useDeliveries } = require("@/entities/delivery");

// A fatia de página inteira (nativos + roda de hooks) monta em ~1s por test e
// o primeiro render da suite disputa CPU com os workers das outras suites —
// o default de 5s estoura só por contenção, não por trava.
jest.setTimeout(15000);

function hookState(overrides) {
  return { deliveries: [], loading: false, reload: jest.fn(), error: null, ...overrides };
}

describe("CourierApp", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });

  test("mostra skeleton quando carregando", async () => {
    useDeliveries.mockReturnValue(hookState({ loading: true }));
    const { getByText } = await render(<CourierApp />);
    expect(getByText("Carregando entregas…")).toBeTruthy();
  });

  test("mostra UM estado vazio quando não há entregas", async () => {
    // O acoplamento "Em rota" também desenhava o vazio global: quando a lista
    // vinha vazia o texto aparecia duas vezes e `getByText` (que é como o
    // usuário lê) ficava ambíguo. Este teste é o que pega essa regressão.
    useDeliveries.mockReturnValue(hookState({}));
    const { getByText } = await render(<CourierApp />);
    expect(getByText("Sem entregas atribuídas no momento")).toBeTruthy();
  });

  test("mostra erro bloqueante quando não há dados", async () => {
    useDeliveries.mockReturnValue(hookState({ error: new Error("falha") }));
    const { getByText } = await render(<CourierApp />);
    expect(getByText("Não foi possível carregar suas entregas")).toBeTruthy();
  });

  test("agrupa entregas por seção", async () => {
    const now = Date.now();
    const deliveries = [
      { id: "a1", status: "out_for_delivery", dispatchedAt: new Date(now - 1 * 60 * 1000).toISOString(), customerName: "A", orderId: "1" },
      { id: "q1", status: "awaiting_courier", createdAt: new Date(now - 5 * 60 * 1000).toISOString(), customerName: "B", orderId: "2" },
      { id: "f1", status: "failed", createdAt: new Date(now - 10 * 60 * 1000).toISOString(), customerName: "C", orderId: "3", notes: "Cliente ausente" },
    ];
    useDeliveries.mockReturnValue(hookState({ deliveries }));
    const { getByText, queryByText } = await render(<CourierApp />);
    expect(getByText("Em rota")).toBeTruthy();
    expect(getByText("Fila")).toBeTruthy();
    expect(getByText("Com problema")).toBeTruthy();
    expect(getByText("A")).toBeTruthy();
    expect(getByText("B")).toBeTruthy();
    expect(getByText("C")).toBeTruthy();
    expect(getByText("Motivo: Cliente ausente")).toBeTruthy();
    // O motivo da falha é `notes` (escrito pelo PATCH .../fail), e a tela vazia
    // global não pode aparecer ao lado do card de problema.
    expect(queryByText("Sem entregas atribuídas no momento")).toBeNull();
  });
});