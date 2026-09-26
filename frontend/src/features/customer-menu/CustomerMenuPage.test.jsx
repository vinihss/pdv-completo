import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CustomerMenuPage from "./CustomerMenuPage.jsx";

// A página real (todas as telas, com o cardápio, o modal e o carrinho lateral):
// serve de rede de proteção contra erro de runtime em componente que o build
// não pega — referência a helper que ficou no outro arquivo, import faltando,
// prop que não desceu, etc. As regras de linha/modal têm teste próprio.
const baseMenu = {
  merchantName: "Boteco do Zé",
  categories: [
    {
      id: "c1",
      name: "Lanches",
      products: [
        {
          id: "p1",
          name: "X-Burger",
          price: 28,
          description: "Carne 150g, queijo e salada.",
          variations: [
            { name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false },
          ],
        },
        { id: "p2", name: "Chopp 300ml", price: 9.5, variations: null },
      ],
    },
  ],
};

let currentMenu = baseMenu;
vi.mock("@/shared/api/public", () => ({
  getPublicMenu: () => Promise.resolve(currentMenu),
  getActivePublicOrder: () => Promise.resolve(null),
  getPublicCart: () => Promise.resolve(null),
  savePublicCart: () => Promise.resolve({}),
  clearPublicCart: () => Promise.resolve({}),
  lookupPublicCustomer: () => Promise.resolve({ found: false }),
  createPublicOrder: () => Promise.resolve({ orderId: "o1" }),
  getPublicOrderStatus: () => Promise.resolve({ orderStatus: "open" }),
  cancelPublicOrder: () => Promise.resolve({ orderStatus: "cancelled" }),
}));
vi.mock("@/shared/api/store", () => ({ getStoreInfo: () => Promise.resolve({ store: null }) }));
vi.mock("@/shared/hooks", () => ({ usePublicRealtime: () => ({ status: "offline", requestSync: () => {} }) }));

async function renderPage() {
  render(
    <MemoryRouter initialEntries={["/pedido"]}>
      <CustomerMenuPage />
    </MemoryRouter>
  );
  // findAll (e não findBy): com produto em destaque o nome aparece na vitrine
  // e na categoria ao mesmo tempo.
  await screen.findAllByText("X-Burger");
}

describe("CustomerMenuPage (integração)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMenu = baseMenu;
    // jsdom não faz layout: scrollIntoView não existe, e o teste quer saber
    // qual seção foi alvo do clique.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("carrega o cardápio e monta os cards com preço em BRL", async () => {
    await renderPage();
    expect(screen.getByText("Chopp 300ml")).toBeTruthy();
    expect(screen.getAllByText("Lanches").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/28,00/).length).toBeGreaterThan(0);
  });

  it("Produto com variação abre a ficha (não entra no carrinho em um toque)", async () => {
    await renderPage();

    // Sem botão de "+": o clique no card abre a ficha completa (foto,
    // variações, quantidade) antes de adicionar.
    fireEvent.click(screen.getByLabelText("Ver X-Burger"));
    await screen.findByRole("dialog");
    // confirmar sem opção obrigatória não cria linha
    fireEvent.click(screen.getByText("Adicionar ao carrinho"));
    expect(screen.getByText("Selecione uma opção obrigatória.")).toBeTruthy();

    fireEvent.click(screen.getByText("Ao ponto"));
    fireEvent.click(screen.getByText("Adicionar ao carrinho"));
    await waitFor(() => expect(screen.queryByText("Selecione uma opção obrigatória.")).toBeNull());
    // A linha está no carrinho (a barra aparece) — e ela só é visível na tela
    // do carrinho, porque o painel lateral do desktop foi removido.
    fireEvent.click(screen.getByText(/Ver carrinho/));
    await screen.findByText("Seu carrinho");
    expect(screen.getByText("X-Burger")).toBeTruthy();
  });

  it("Produto sem variação também abre a ficha antes de adicionar", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Ver Chopp 300ml"));
    await screen.findByRole("dialog");
    // ficha completa: controle de quantidade presente antes de adicionar
    expect(screen.getByLabelText("Aumentar quantidade de Chopp 300ml")).toBeTruthy();
    fireEvent.click(screen.getByText("Adicionar ao carrinho"));
    // sem bloqueio: a linha entra no carrinho e a barra aparece
    await waitFor(() => expect(screen.getByText(/Ver carrinho/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Ver carrinho/));
    await screen.findByText("Seu carrinho");
    expect(screen.getByText("Chopp 300ml")).toBeTruthy();
  });

  it("abre o checkout a partir do carrinho", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Ver Chopp 300ml"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("Adicionar ao carrinho"));
    await waitFor(() => expect(screen.getByText(/Ver carrinho/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Ver carrinho/));
    await screen.findByText("Seu carrinho");
    expect(screen.getByText("Chopp 300ml")).toBeTruthy();
    fireEvent.click(screen.getByText(/Continuar/));
    await screen.findByText("Identificação");
  });
});

// ---------------------------------------------------------------------------
// Layout de loja: destaques, seções, pills por âncora e a barra que só
// aparece depois de rolar.
// ---------------------------------------------------------------------------
const withFeatured = () => ({
  merchantName: "Boteco do Zé",
  categories: [
    {
      id: "c1",
      name: "Lanches",
      products: [
        { id: "p1", name: "X-Burger", price: 28, description: "Carne 150g.", variations: null, featured: true },
        { id: "p2", name: "Chopp 300ml", price: 9.5, variations: null, featured: false },
      ],
    },
    { id: "c2", name: "Porções", products: [{ id: "p3", name: "Batata frita", price: 22, variations: null, featured: false }] },
  ],
});

// jsdom não tem layout: finja um documento rolável para a barra poder
// sumir no topo e aparecer ao rolar.
function fakeScrollable() {
  const se = document.documentElement;
  let top = 0;
  Object.defineProperty(se, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(se, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(se, "scrollTop", { get: () => top, configurable: true });
  return {
    scrollTo: (value) => {
      top = value;
      window.dispatchEvent(new Event("scroll"));
    },
  };
}

describe("CustomerMenuPage (layout de loja)", () => {
  it("sem produto em destaque, não existe a seção/pill Destaques", async () => {
    await renderPage();
    expect(screen.queryByText("Destaques")).toBeNull();
    expect(screen.getAllByText("Lanches").length).toBeGreaterThan(0);
  });

  it("produto em destaque abre a vitrine e continua na categoria", async () => {
    currentMenu = withFeatured();
    await renderPage();

    expect(screen.getAllByText("Destaques").length).toBe(2); // pill + título da seção
    // o mesmo produto aparece na vitrine e na sua categoria (comportamento iFood)
    const titulos = screen.getAllByText("X-Burger");
    expect(titulos).toHaveLength(2);
    // no tile o preço vem ANTES do título (logo abaixo da foto)
    expect(titulos[0].previousElementSibling?.textContent).toContain("28,00");
  });

  it("O mesmo produto em destaque é alcançável em vitrine e na categoria", async () => {
    // Regressão: antes, produto em destaque tinha dois steppers com
    // aria-label idêntico ("Adicionar X-Burger"), deixando getByLabelText
    // ambíguo. Agora não há stepper — o clique no card abre a ficha, que é o
    // gatilho único para qualquer um dos dois.
    currentMenu = withFeatured();
    await renderPage();

    const botoesVer = screen.getAllByLabelText("Ver X-Burger");
    expect(botoesVer).toHaveLength(2);
    // abre a ficha a partir da vitrine (primeiro botão)
    fireEvent.click(botoesVer[0]);
    await screen.findByRole("dialog");
    // sem variação: adicionar direto — o modal fecha e o badge aparece nos
    // dois cards (vitrine e categoria)
    fireEvent.click(screen.getByText("Adicionar ao carrinho"));
    await waitFor(() => expect(screen.getAllByText("1 no carrinho")).toHaveLength(2));
    // ...e a ficha abre também a partir da categoria (segundo botão)
    fireEvent.click(botoesVer[1]);
    await screen.findByRole("dialog");
    expect(screen.getByText("Adicionar ao carrinho")).toBeTruthy();
  });

  it("a pill rola até a seção em vez de filtrar", async () => {
    currentMenu = withFeatured();
    await renderPage();
    fireEvent.click(screen.getAllByText("Porções")[0]); // a pill, não o título da seção
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // nada foi filtrado: as duas seções continuam na tela
    expect(screen.getAllByText("Destaques").length).toBe(2);
    expect(screen.getByText("Batata frita")).toBeTruthy();
  });

  it("a busca troca as seções por uma lista de resultados", async () => {
    currentMenu = withFeatured();
    await renderPage();
    fireEvent.change(screen.getByLabelText("Buscar produto"), { target: { value: "batata" } });

    expect(screen.getByText("Resultados")).toBeTruthy();
    expect(screen.getByText("Batata frita")).toBeTruthy();
    expect(screen.queryAllByText("X-Burger")).toHaveLength(0);
    expect(screen.queryAllByText("Destaques")).toHaveLength(0);
  });

  it("busca sem resultado mostra o estado vazio", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("Buscar produto"), { target: { value: "zzzz" } });
    expect(screen.getByText("Nenhum produto encontrado.")).toBeTruthy();
  });

  it("a barra de busca fica escondida no topo e aparece ao rolar", async () => {
    const scroll = fakeScrollable();
    await renderPage();

    const sticky = () => screen.getByLabelText("Buscar produto").closest(".sticky");
    expect(sticky().className).toContain("max-h-0");
    expect(sticky().className).toContain("pointer-events-none");

    scroll.scrollTo(300);
    await waitFor(() => expect(sticky().className).toContain("max-h-40"));
    expect(sticky().className).toContain("opacity-100");
  });

  it("com o cardápio curto (não rola), a barra fica sempre visível", async () => {
    // scrollHeight == clientHeight: nada para rolar, logo a busca não pode
    // ficar escondida — senão o cliente nunca encontra o produto.
    const se = document.documentElement;
    Object.defineProperty(se, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(se, "clientHeight", { value: 600, configurable: true });
    await renderPage();
    expect(screen.getByLabelText("Buscar produto").closest(".sticky").className).toContain("max-h-40");
  });
});
