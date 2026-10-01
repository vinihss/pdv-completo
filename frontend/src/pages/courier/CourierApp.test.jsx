import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

/**
 * A tela do entregador era o maior buraco de cobertura do frontend: 176 linhas,
 * um arquivo só, zero teste — e é a tela que alguém usa na rua, com uma mão.
 *
 * Dublados: `useDeliveries` (evita WebSocket + fetch) e o `playAlertSound` da
 * entity de alerta — o som de "pedido novo" é o que garante que o entregador
 * olhe para a tela.
 *
 * As MUTATIONS NÃO são doubladas: elas são as reais de `@/entities/delivery`, e
 * quem é doublado é o `request` de `@/shared/api/http`. Assim o teste do botão
 * "Saí para entrega" não afirma só "a função foi chamada", afirma o ENDPOINT
 * (`PATCH /courier/deliveries/:id/dispatch`) — que é o contrato com o backend,
 * e o que quebra em silêncio se alguém trocar a rota.
 */
const mocks = vi.hoisted(() => ({
  useDeliveries: vi.fn(),
  request: vi.fn(),
  playAlertSound: vi.fn(),
}));

vi.mock("@/entities/delivery", async (orig) => ({
  ...(await orig()),
  useDeliveries: (...args) => mocks.useDeliveries(...args),
}));

vi.mock("@/entities/alert", async (orig) => ({
  ...(await orig()),
  playAlertSound: (...args) => mocks.playAlertSound(...args),
  isAlertSoundEnabled: () => true,
}));

vi.mock("@/shared/api/http", () => ({
  request: (...args) => mocks.request(...args),
  upload: vi.fn(),
  pingApi: vi.fn(),
  setAuthToken: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));

const { default: CourierApp } = await import("./CourierApp.jsx");

const AGORA = Date.now();
const minutosAtras = (min) => new Date(AGORA - min * 60_000).toISOString();

function entrega(over = {}) {
  return {
    id: "d-1",
    orderId: "abcdefgh-1234-5678-9012-abcdefabcdef",
    address: "Rua das Flores, 123 - Centro",
    status: "awaiting_courier",
    createdAt: minutosAtras(23),
    dispatchedAt: null,
    deliveredAt: null,
    notes: null,
    ...over,
  };
}

function setup(hook = {}) {
  const reload = vi.fn().mockResolvedValue(undefined);
  mocks.useDeliveries.mockReturnValue({ deliveries: [], loading: false, reload, ...hook });
  const utils = render(<CourierApp />);
  return { ...utils, reload };
}

/** Deixa o `navigator.onLine` controllable — o banner é lido do SO. */
function comSinal(ligado) {
  Object.defineProperty(window.navigator, "onLine", { value: ligado, configurable: true });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  comSinal(true);
  mocks.request.mockResolvedValue({ ok: true });
});

describe("CourierApp — as três seções", () => {
  it("separa em rota, fila e problema, e põe a ativa em hero", () => {
    setup({
      deliveries: [
        entrega({ id: "d-ativa", status: "out_for_delivery", dispatchedAt: minutosAtras(12) }),
        entrega({ id: "d-fila", status: "awaiting_courier" }),
        entrega({ id: "d-falha", status: "failed", notes: "Cliente ausente" }),
      ],
    });

    expect(screen.getByText("Em rota · 1")).toBeTruthy();
    expect(screen.getByText("Fila · 1")).toBeTruthy();
    expect(screen.getByText("Problemas · 1")).toBeTruthy();

    expect(screen.getByTestId("delivery-card-hero")).toBeTruthy();
    expect(screen.getByTestId("delivery-card-queue")).toBeTruthy();
    expect(screen.getByTestId("delivery-card-failed")).toBeTruthy();

    // A entrega em rota é a hero: é a próxima parada, não a última da lista.
    expect(screen.getByTestId("delivery-card-hero").textContent).toContain("Rua das Flores, 123");
    // A com problema é calma: o estado diz que o gerente assume, e não há
    // NENHUM botão — marcar de novo não é possível pela máquina de status.
    const failed = screen.getByTestId("delivery-card-failed");
    expect(failed.textContent).toContain("Problema na entrega — o gerente vai resolver");
    expect(failed.textContent).toContain("Motivo: Cliente ausente");
    expect(failed.querySelectorAll("button, a").length).toBe(0);
  });

  it("a ação primária da hero tem 56px de altura (alcance de polegar)", () => {
    setup({
      deliveries: [entrega({ id: "d-ativa", status: "out_for_delivery", dispatchedAt: minutosAtras(12) })],
    });

    // `h-14` = 56px no Tailwind: o critério de polegar da tela do entregador.
    const primary = screen.getByText("Entreguei").closest("button");
    expect(primary.className).toContain("h-14");
  });

  it("mostra o tempo decorrido e o deep link do mapa", () => {
    setup({
      deliveries: [entrega({ id: "d-ativa", status: "out_for_delivery", dispatchedAt: minutosAtras(12) })],
    });

    expect(screen.getByTestId("delivery-elapsed").textContent).toContain("saiu há 12 min");
    const rota = screen.getByLabelText(/Abrir rota/).getAttribute("href");
    expect(rota).toBe(
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Rua das Flores, 123 - Centro")
    );
  });

  it("destaca a parada antiga e mostra nome, canal e telefone quando vêm", () => {
    setup({
      deliveries: [
        entrega({
          customerName: "Maria Silva",
          channel: "whatsapp",
          customerPhone: "11987654321",
          estimatedMinutes: 30,
          createdAt: minutosAtras(35),
        }),
      ],
    });

    // 35 min de fila passa do limite (20): o chip fica vermelho e pulsa.
    const elapsed = screen.getByTestId("delivery-elapsed");
    expect(elapsed.textContent).toContain("parada há 35 min");
    expect(elapsed.className).toContain("urgent-pulse");

    expect(screen.getByText("Maria Silva")).toBeTruthy();
    expect(screen.getByText("WhatsApp")).toBeTruthy();
    expect(screen.getByText("≈ 30 min")).toBeTruthy();
    expect(screen.getByLabelText("Ligar para Maria Silva").getAttribute("href")).toBe("tel:11987654321");
  });

  it("a fila sai da mais antiga para a mais nova (é a ordem de dá para sair)", () => {
    setup({
      deliveries: [
        entrega({ id: "d-nova", address: "Rua Nova, 2", createdAt: minutosAtras(3) }),
        entrega({ id: "d-velha", address: "Rua Velha, 1", createdAt: minutosAtras(40) }),
      ],
    });

    const fila = screen.getAllByTestId("delivery-card-queue");
    expect(fila[0].textContent).toContain("Rua Velha, 1");
    expect(fila[1].textContent).toContain("Rua Nova, 2");
  });

  it("problemas: a mais recente primeiro, que é a que o gerente resolve primeiro", () => {
    setup({
      deliveries: [
        entrega({ id: "d-f1", address: "Problema Antigo, 1", status: "failed", createdAt: minutosAtras(60) }),
        entrega({ id: "d-f2", address: "Problema Recente, 2", status: "failed", createdAt: minutosAtras(5) }),
      ],
    });

    const problemas = screen.getAllByTestId("delivery-card-failed");
    expect(problemas[0].textContent).toContain("Problema Recente, 2");
    expect(problemas[1].textContent).toContain("Problema Antigo, 1");
  });

  it("duas em trânsito: a mais antiga é a hero e a outra continua visível como compacta", () => {
    setup({
      deliveries: [
        entrega({ id: "d-2", address: "Segunda Parada, 2", status: "out_for_delivery", dispatchedAt: minutosAtras(2) }),
        entrega({ id: "d-1", address: "Primeira Parada, 1", status: "out_for_delivery", dispatchedAt: minutosAtras(30) }),
      ],
    });

    expect(screen.getByText("Em rota · 2")).toBeTruthy();
    // A hero é a que ele está fazendo agora (a mais antiga em trânsito).
    expect(screen.getByTestId("delivery-card-hero").textContent).toContain("Primeira Parada, 1");
    // A segunda não é escondida: perdê-la seria pior que repetir um card.
    expect(screen.getByTestId("delivery-card-compact").textContent).toContain("Segunda Parada, 2");
  });

  it("entregue e cancelado não aparecem — já foram, não são trabalho", () => {
    setup({
      deliveries: [
        entrega({ id: "d-ok", status: "delivered", address: "Rua Entregue, 9" }),
        entrega({ id: "d-canc", status: "cancelled", address: "Rua Cancelada, 10" }),
      ],
    });

    expect(screen.getByText("Tudo em dia por aqui")).toBeTruthy();
    expect(screen.queryByText(/Rua Entregue/)).toBeNull();
    expect(screen.queryByText(/Rua Cancelada/)).toBeNull();
  });

  it("mostra itens e observação do pedido, que é o que evita o retorno", () => {
    setup({
      deliveries: [
        entrega({
          items: [
            { name: "X-Burger", quantity: 2, notes: "sem cebola" },
            { name: "Coca" },
          ],
          orderNotes: "entregar bem gelado",
        }),
      ],
    });

    const card = screen.getByTestId("delivery-card-queue");
    expect(card.textContent).toContain("2× X-Burger — sem cebola");
    expect(card.textContent).toContain("Coca");
    expect(card.textContent).toContain("OBS: entregar bem gelado");
  });

  it("o motivo da falha nunca aparece como observação do pedido", () => {
    setup({
      deliveries: [entrega({ id: "d-f", status: "failed", notes: "Cliente ausente", createdAt: minutosAtras(9) })],
    });

    const card = screen.getByTestId("delivery-card-failed");
    expect(card.textContent).toContain("Cliente ausente");
    // `notes` em `failed` é o motivo — não pode reaparecer como observação.
    expect(card.textContent).not.toContain("OBS:");
  });
});

describe("CourierApp — ações", () => {
  it('"Saí para entrega" chama PATCH /courier/deliveries/:id/dispatch e recarrega', async () => {
    const { reload } = setup({ deliveries: [entrega()] });

    fireEvent.click(screen.getByText("Saí para entrega"));

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("PATCH", "/courier/deliveries/d-1/dispatch")
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
    // Só o dispatch: uma falha aqui seria erro de máquina de status.
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('"Entreguei" chama PATCH /courier/deliveries/:id/deliver', async () => {
    const { reload } = setup({
      deliveries: [entrega({ status: "out_for_delivery", dispatchedAt: minutosAtras(4) })],
    });

    fireEvent.click(screen.getByText("Entreguei"));

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("PATCH", "/courier/deliveries/d-1/deliver")
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("presets de falha preenchem o motivo, e Confirmar falha manda o motivo no corpo", async () => {
    setup({ deliveries: [entrega({ status: "out_for_delivery", dispatchedAt: minutosAtras(4) })] });

    fireEvent.click(screen.getByText("Problema na entrega"));
    // O motivo é obrigatório na prática, mas na rua não se digita: 1 toque.
    expect(screen.getByRole("button", { name: "Confirmar falha" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cliente ausente" }));
    expect(screen.getByLabelText(/Detalhe/).value).toBe("Cliente ausente");
    expect(screen.getByRole("button", { name: "Confirmar falha" }).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirmar falha" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("PATCH", "/courier/deliveries/d-1/fail", {
        reason: "Cliente ausente",
      })
    );
    // O modal some junto com a confirmação — nada fica aberto por cima da lista.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirmar falha" })).toBeNull());
  });

  it("o campo continua editável depois do preset (o que não couber nos 5)", () => {
    setup({ deliveries: [entrega({ status: "out_for_delivery", dispatchedAt: minutosAtras(4) })] });

    fireEvent.click(screen.getByText("Problema na entrega"));
    fireEvent.click(screen.getByRole("button", { name: "Cliente ausente" }));

    const campo = screen.getByLabelText(/Detalhe/);
    fireEvent.change(campo, { target: { value: "Portão fechado, vizinho não sabe" } });
    expect(campo.value).toBe("Portão fechado, vizinho não sabe");
  });

  it("não oferece falha na fila (a máquina de status recusa)", () => {
    setup({ deliveries: [entrega({ status: "awaiting_courier" })] });
    expect(screen.queryByText("Problema na entrega")).toBeNull();
  });

  it("card sem orderId, endereço, canal ou telefone não quebra o layout", () => {
    setup({
      deliveries: [{ id: "d-pobre", status: "awaiting_courier", createdAt: minutosAtras(2) }],
    });

    const card = screen.getByTestId("delivery-card-queue");
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("Cliente sem nome");
    expect(card.textContent).toContain("Endereço não informado");
    expect(card.textContent).not.toContain("Pedido #");
    expect(screen.getByText("Saí para entrega")).toBeTruthy();
  });
});

describe("CourierApp — estados", () => {
  it("carregando mostra esqueleto, não texto", () => {
    setup({ loading: true, deliveries: [] });
    expect(screen.getByTestId("courier-skeleton")).toBeTruthy();
    expect(screen.queryByText("Tudo em dia por aqui")).toBeNull();
  });

  it("erro do hook mostra retry que recarrega", () => {
    const { reload } = setup({ deliveries: [], error: new Error("sem rede") });

    expect(screen.getByText("Não consegui carregar suas entregas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(reload).toHaveBeenCalled();
  });

  it("funciona com o hook sem `error` — o campo é opcional enquanto o outro agente não o entrega", () => {
    // `undefined` é o estado normal: sem esta tela quebrar no `error` do hook,
    // o contrato novo só pode ADICIONAR a fonte de erro, nunca virar requisito.
    setup({ deliveries: [entrega()] });
    expect(screen.getByText("Fila · 1")).toBeTruthy();
    expect(screen.queryByText("Não consegui carregar suas entregas")).toBeNull();
  });

  it("reload que rejeita também vira estado de erro (o hook ainda não expõe `error`)", async () => {
    const reload = vi.fn().mockRejectedValue(new Error("500"));
    mocks.useDeliveries.mockReturnValue({ deliveries: [], loading: false, reload });

    render(<CourierApp />);
    // Sem `error` vindo do hook, o caminho de erro que a tela consegue ver é o
    // reload disparado por ELA (botão do header) — e ele precisa virar tela de
    // erro, não o vazio de "tudo em dia".
    fireEvent.click(screen.getByRole("button", { name: "Atualizar entregas" }));

    await waitFor(() => expect(screen.getByText("Não consegui carregar suas entregas")).toBeTruthy());
    expect(reload).toHaveBeenCalled();
  });

  it("recarga que falha com lista na tela avisa e mantém a lista (estado velho, não tela de erro)", async () => {
    const reload = vi.fn().mockRejectedValue(new Error("500"));
    mocks.useDeliveries.mockReturnValue({
      deliveries: [entrega({ address: "Rua Velha, 1" })],
      loading: false,
      reload,
    });

    render(<CourierApp />);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar entregas" }));

    await waitFor(() => expect(screen.getByText("Não consegui atualizar a lista.")).toBeTruthy());
    expect(screen.getByTestId("delivery-card-queue").textContent).toContain("Rua Velha, 1");
    expect(screen.queryByText("Não consegui carregar suas entregas")).toBeNull();
  });

  it("sem sinal mostra o aviso de que a lista é a última conhecida", () => {
    comSinal(false);
    setup({ deliveries: [entrega()] });
    expect(screen.getByText(/Sem conexão/)).toBeTruthy();
  });

  it("voltar a ter sinal recarrega a lista (a do entregador estava parada no carro)", () => {
    comSinal(false);
    const { reload } = setup({ deliveries: [] });
    expect(reload).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    // A borda é o gatilho; a primeira renderização não gera requisição.
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fila vazia com entrega em rota não diz que está tudo em dia", () => {
    setup({ deliveries: [entrega({ status: "out_for_delivery", dispatchedAt: minutosAtras(4) })] });

    expect(screen.getByText("Nada na fila")).toBeTruthy();
    expect(screen.queryByText("Tudo em dia por aqui")).toBeNull();
  });

  it("sem nada nenhum, o vazio é o de fim de turno", () => {
    setup({ deliveries: [] });
    expect(screen.getByText("Tudo em dia por aqui")).toBeTruthy();
  });
});

describe("CourierApp — pedido novo", () => {
  it("toca som e avisa quando uma entrega entra na lista", async () => {
    const { rerender } = setup({ deliveries: [] });
    expect(mocks.playAlertSound).not.toHaveBeenCalled();

    // O realtime recarrega a lista: o hook (de outro agente) não distingue o
    // tipo do evento, então a tela detecta o id novo por diferença.
    mocks.useDeliveries.mockReturnValue({
      deliveries: [entrega({ id: "d-nova", customerName: "Maria Silva" })],
      loading: false,
      reload: vi.fn(),
    });
    rerender(<CourierApp />);

    await waitFor(() => expect(mocks.playAlertSound).toHaveBeenCalledWith("order_created"));
    await waitFor(() => expect(screen.getByText("Novo pedido: Maria Silva")).toBeTruthy());
  });

  it("não toca som na primeira carga nem depois de ação do próprio usuário", async () => {
    // `[...lista]` de propósito: o hook devolvendo o MESMO array não dispara o
    // efeito de detecção, e o teste passaria sem exercitar nada.
    let lista = [entrega({ id: "d-1", customerName: "Maria Silva" })];
    mocks.useDeliveries.mockImplementation(() => ({
      deliveries: [...lista],
      loading: false,
      reload: vi.fn().mockResolvedValue(undefined),
    }));
    // O que o `reload` traz logo depois do toque: a mesma entrega com status
    // novo + OUTRA que entrou na fila. Sem `markSelfAction`, essa segunda
    // dispararia som e toast — quem acabou de tocar não precisa de aviso.
    mocks.request.mockImplementation(async () => {
      lista = [...lista, entrega({ id: "d-2", customerName: "Joana" })];
      return { ok: true };
    });

    render(<CourierApp />);

    // Primeira carga com entrega pendente é LINHA DE BASE, não pedido novo:
    // quem abre o app no meio do turno não pode ouvir um bip por card.
    expect(mocks.playAlertSound).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Saí para entrega"));
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Fila · 2")).toBeTruthy());

    expect(mocks.playAlertSound).not.toHaveBeenCalled();
    expect(screen.queryByText(/Novo pedido/)).toBeNull();
  });
});