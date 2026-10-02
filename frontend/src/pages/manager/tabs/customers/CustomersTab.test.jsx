import React from "react";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import CustomerModal from "./CustomerModal.jsx";
import CustomersTab from "./CustomersTab.jsx";

// ---------------------------------------------------------------------------
// Rede stubbada por rota.
//
// A tela de visualização lê quatro URLs (ficha, resumo, histórico paginado e a
// lista) e a mutação do modal mais o `GET /customers/:id` dos endereços. Em
// node a URL relativa é inválida pro fetch, então o stub é por URL — e não um
// "resolve com qualquer coisa": é o que prova que a tela pede a página certa
// do histórico e monta a prévia com 5 e não com o histórico inteiro.
// ---------------------------------------------------------------------------

const LISTA = [
  { id: "c1", name: "Maria Silva", phone: "11987654321", email: "maria@exemplo.com", addressCount: 1, active: true },
  { id: "c2", name: "Joao Souza", phone: null, email: null, addressCount: 0, active: true },
];

const DETALHE_BASE = {
  id: "c1",
  name: "Maria Silva",
  phone: "11987654321",
  email: "maria@exemplo.com",
  cpf: "52998224725",
  notes: "Pede sem cebola.",
  photoPath: null,
  active: true,
  addressCount: 1,
  createdAt: "2026-01-05T12:00:00.000Z",
  addresses: [],
  openOrders: [],
};

// Timestamp em MEIO-DIA do dia local, não meia-noite UTC: o agrupamento por
// dia da tela é no calendário de quem olha, e um `...T00:00:00Z` vira o dia
// anterior em qualquer fuso atrás de Greenwich — o teste passaria ou falharia
// conforme a máquina.
const emDia = (ano, mes, dia, hora = 19) => new Date(ano, mes - 1, dia, hora).toISOString();

// 6 comandas fechadas: uma a mais do que a prévia mostra, para o "Carregar
// mais" ter o que buscar. Só a comanda 1 caiu em 10/09 — é o dia com venda na
// série do `RESUMO_COMPRAS`, e o filtro por dia tem que achar exatamente ela.
const ORDENS = Array.from({ length: 6 }, (_, i) => ({
  id: `o${i + 1}`,
  status: "closed",
  openedAt: emDia(2026, 9, i === 0 ? 10 : 20 + i),
  closedAt: emDia(2026, 9, i === 0 ? 10 : 20 + i),
  tableNumber: null,
  tabLabel: `Pedido ${i + 1}`,
  paymentMethod: "pix",
  total: 50 + i,
  itemCount: i + 1,
}));

const RESUMO_VAZIO = { from: "2026-09-03", to: "2026-10-02", series: [], totals: { total: 0, orderCount: 0 } };
const RESUMO_COMPRAS = {
  from: "2026-09-03",
  to: "2026-10-02",
  series: [
    { day: "2026-09-10", label: "10/09", total: 50, orderCount: 1 },
    { day: "2026-09-11", label: "11/09", total: 0, orderCount: 0 },
  ],
  totals: { total: 50, orderCount: 1 },
};

// Mutáveis: cada teste escolhe o que a ficha devolve.
let detalhe = DETALHE_BASE;
let resumo = RESUMO_VAZIO;

function json(payload) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
  );
}

function routeFetch(input) {
  const [path, query] = String(input).split("?");
  const params = new URLSearchParams(query ?? "");

  if (/\/customers\/c1\/orders$/.test(path)) {
    const limit = Number(params.get("limit") ?? 20);
    const offset = Number(params.get("offset") ?? 0);
    // A rota não filtra por data (o filtro por dia é da tela), então o stub só
    // pagina — é assim que o teste prova que a prévia pede 5 e o resto por
    // "Carregar mais".
    return json({ data: ORDENS.slice(offset, offset + limit), total: ORDENS.length });
  }
  if (/\/customers\/c1\/summary$/.test(path)) return json(resumo);
  if (/\/customers\/c1$/.test(path)) return json(detalhe);
  if (/\/customers$/.test(path)) return json({ data: LISTA, total: LISTA.length });
  // qualquer outra coisa (o `GET /customers/:id` dos endereços, no modal)
  return json({ id: "c1", addresses: [] });
}

beforeEach(() => {
  detalhe = DETALHE_BASE;
  resumo = RESUMO_VAZIO;
  vi.stubGlobal("fetch", (input) => routeFetch(input));
  // O jsdom não tem `ResizeObserver`, que o `ResponsiveContainer` do recharts
  // instancia no mount. Stub vazio: o gráfico não mede nada, e o teste só
  // precisa saber se a série chegou a ser desenhada.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterAll(() => vi.unstubAllGlobals());

const showToast = () => {};

// O `CustomerModal` só é montado em runtime pelas abas Clientes (gerente e
// caixa), então build/tsc não protegem o JSX dele. Este é o teste de
// montagem.
describe("CustomerModal", () => {
  it("criação: nome, telefone, email, CPF, observações e ação no rodapé", () => {
    render(<CustomerModal onClose={() => {}} onSaved={async () => {}} showToast={showToast} />);
    expect(screen.getByRole("dialog", { name: "Novo cliente" })).toBeTruthy();
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByText("Telefone")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("CPF (opcional)")).toBeTruthy();
    expect(screen.getByText("Observações")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar cliente" })).toBeTruthy();
    cleanup();
  });

  it("edição: campos preenchidos e seção de endereços", () => {
    const customer = {
      id: "c1",
      name: "Maria Silva",
      phone: "11987654321",
      email: "maria@exemplo.com",
      cpf: "52998224725",
      notes: "Pede sem cebola.",
      addresses: [
        {
          id: "a1",
          label: "Casa",
          cep: "01001000",
          street: "Rua das Flores",
          number: "123",
          neighborhood: "Centro",
          city: "Sao Paulo",
          state: "SP",
          isDefault: true,
        },
      ],
    };
    render(<CustomerModal customer={customer} onClose={() => {}} onSaved={async () => {}} showToast={showToast} />);
    expect(screen.getByRole("dialog", { name: "Editar cliente" })).toBeTruthy();
    expect(screen.getByDisplayValue("Maria Silva")).toBeTruthy();
    expect(screen.getByDisplayValue("(11) 98765-4321")).toBeTruthy();
    expect(screen.getByDisplayValue("529.982.247-25")).toBeTruthy();
    expect(screen.getByDisplayValue("Pede sem cebola.")).toBeTruthy();
    expect(screen.getByText("Endereços (1/3)")).toBeTruthy();
    expect(screen.getByText("Casa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adicionar endereço" })).toBeTruthy();
    cleanup();
  });

  it("CPF com dígito verificador errado é recusado no campo", () => {
    render(
      <CustomerModal customer={{ id: "c1", name: "Maria" }} onClose={() => {}} onSaved={async () => {}} showToast={showToast} />
    );
    fireEvent.change(screen.getByDisplayValue("Maria"), { target: { value: "Maria Silva" } });
    const cpfInput = screen.getByPlaceholderText("000.000.000-00");
    fireEvent.change(cpfInput, { target: { value: "123.456.789-00" } }); // DV errado de propósito
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(screen.getByText("CPF inválido — confira os dígitos verificadores.")).toBeTruthy();
    cleanup();
  });
});

describe("CustomersTab — lista e ficha do cliente", () => {
  it("a lista não tem mais lápis: o card abre a ficha", async () => {
    render(<CustomersTab showToast={showToast} />);
    const card = await screen.findByRole("button", { name: "Ver ficha de Maria Silva" });
    // O ícone de edição saiu do card — edição é o botão da ficha.
    expect(screen.queryByTitle("Editar cliente")).toBeNull();

    fireEvent.click(card);
    expect(await screen.findByRole("heading", { name: "Maria Silva" })).toBeTruthy();
    cleanup();
  });

  it("o card também abre pelo teclado (Enter)", async () => {
    render(<CustomersTab showToast={showToast} />);
    const card = await screen.findByRole("button", { name: "Ver ficha de Maria Silva" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Maria Silva" })).toBeTruthy();
    cleanup();
  });

  it("a ficha tem o botão Editar no canto superior direito", async () => {
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));
    await screen.findByRole("heading", { name: "Maria Silva" });
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
    cleanup();
  });

  it("aviso de comanda em aberto aparece quando há comanda aberta", async () => {
    detalhe = {
      ...DETALHE_BASE,
      openOrders: [{ id: "o9", tableNumber: 7, tabLabel: null, openedAt: "2026-10-01T19:10:00.000Z", total: 84.5, status: "open" }],
    };
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("1 comanda em aberto");
    expect(alerta.textContent).toContain("Mesa 7");
    cleanup();
  });

  it("sem comandas abertas, nenhum aviso de comanda", async () => {
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));
    await screen.findByRole("heading", { name: "Maria Silva" });
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
  });

  it("gráfico sem nenhuma compra: texto, nunca um eixo vazio", async () => {
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));
    expect(await screen.findByTestId("customer-chart-empty")).toBeTruthy();
    expect(screen.getByText("Sem compras no período.")).toBeTruthy();
    expect(screen.queryByTestId("customer-chart")).toBeNull();
    cleanup();
  });

  it("gráfico com compras mostra a série", async () => {
    resumo = RESUMO_COMPRAS;
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));
    expect(await screen.findByTestId("customer-chart")).toBeTruthy();
    expect(screen.queryByTestId("customer-chart-empty")).toBeNull();
    cleanup();
  });

  it("escolher um dia mostra os pedidos daquele dia e volta para a prévia", async () => {
    resumo = RESUMO_COMPRAS;
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));

    // 10/09 tem venda: a comanda 1 foi fechada nesse dia.
    fireEvent.click(await screen.findByRole("button", { name: "10/09" }));
    expect(await screen.findByText("Pedidos de 10/09")).toBeTruthy();
    expect(screen.getByText("Pedido 1")).toBeTruthy();
    expect(screen.queryByText("Pedido 2")).toBeNull();

    // 11/09 não tem venda: o gráfico mostra zero e a lista confirma.
    fireEvent.click(screen.getByRole("button", { name: "11/09" }));
    expect(await screen.findByText("Nenhum pedido em 11/09.")).toBeTruthy();

    // Volta para a prévia, e a prévia volta a ser a prévia.
    fireEvent.click(screen.getByRole("button", { name: "Ver todos os pedidos" }));
    await screen.findByText("Pedido 2");
    expect(screen.queryByText("Pedidos de 10/09")).toBeNull();
    cleanup();
  });

  it("histórico abre com a prévia (5) e carrega o resto sob demanda", async () => {
    render(<CustomersTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver ficha de Maria Silva" }));

    // Prévia: as 5 primeiras, e as 6 NÃO vieram.
    await screen.findByText("Pedido 1");
    expect(screen.getByText("Pedido 5")).toBeTruthy();
    expect(screen.queryByText("Pedido 6")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais (1)" }));
    expect(await screen.findByText("Pedido 6")).toBeTruthy();
    // Acabou o histórico: o botão some em vez de ficar asking por página vazia.
    expect(screen.queryByRole("button", { name: /Carregar mais/ })).toBeNull();
    cleanup();
  });
});
