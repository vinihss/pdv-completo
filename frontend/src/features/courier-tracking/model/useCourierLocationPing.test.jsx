import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

/**
 * O hook de ping é a peça que decide bateria e privacidade do entregador:
 * ele NÃO pode rodar sem entrega em rota e NÃO pode parar de tentar por
 * causa de um POST que falhou. Aqui o GPS é um dublê de
 * `navigator.geolocation` e o POST é dublado na fronteira de rede
 * (`@/shared/api/http`), como nas outras suítes.
 */
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getCurrentPosition: vi.fn(),
}));

vi.mock("@/shared/api/http", () => ({
  request: (...args) => mocks.request(...args),
  upload: vi.fn(),
  pingApi: vi.fn(),
  setAuthToken: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));

const { useCourierLocationPing, PING_INTERVAL_MS } = await import("./useCourierLocationPing.js");

const POS = {
  coords: { latitude: -23.55, longitude: -46.63, accuracy: 12 },
};

function Probe({ active }) {
  const { position, permissionDenied, supported } = useCourierLocationPing({ active });
  return (
    <div>
      <span data-testid="position">{position ? `${position.latitude},${position.longitude}` : "—"}</span>
      <span data-testid="denied">{String(permissionDenied)}</span>
      <span data-testid="supported">{String(supported)}</span>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.request.mockReset().mockResolvedValue({});
  mocks.getCurrentPosition.mockReset().mockImplementation((ok) => ok(POS));
  Object.defineProperty(navigator, "geolocation", {
    value: { getCurrentPosition: (...a) => mocks.getCurrentPosition(...a) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});

describe("useCourierLocationPing", () => {
  it("não lê GPS nem envia nada sem entrega em rota", () => {
    render(<Probe active={false} />);
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS * 3));
    expect(mocks.getCurrentPosition).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("envia a posição na ativação e a cada intervalo", () => {
    render(<Probe active={true} />);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("POST", "/courier/location", {
      latitude: -23.55,
      longitude: -46.63,
      accuracy: 12,
    });

    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("expõe a última posição local para o marker do mapa", () => {
    // O dublê responde sincronamente, então o estado já está na tela no
    // primeiro render — sem `waitFor` (que precisaria de timers reais).
    const { getByTestId } = render(<Probe active={true} />);
    expect(getByTestId("position").textContent).toBe("-23.55,-46.63");
  });

  it("permissão negada vira estado visual, sem derrubar o hook", () => {
    mocks.getCurrentPosition.mockImplementation((ok, err) => err({ code: 1 }));
    const { getByTestId } = render(<Probe active={true} />);
    expect(getByTestId("denied").textContent).toBe("true");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("POST que falha não para o ciclo: o tick seguinte tenta de novo", () => {
    mocks.request.mockRejectedValueOnce(new Error("sem entrega em rota"));
    render(<Probe active={true} />);
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("para de enviar quando a última entrega em rota sai da lista", () => {
    const { rerender } = render(<Probe active={true} />);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    rerender(<Probe active={false} />);
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS * 2));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("marca supported=false quando o aparelho não tem geolocation", () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    const { getByTestId } = render(<Probe active={true} />);
    expect(getByTestId("supported").textContent).toBe("false");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
