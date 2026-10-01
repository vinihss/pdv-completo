import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
vi.mock("@/entities/product", async (importOriginal) => ({
  ...(await importOriginal()),
  getPublicMenu: () => Promise.resolve(currentMenu),
}));
vi.mock("@/entities/order", async (importOriginal) => ({
  ...(await importOriginal()),
  createPublicOrder: () => Promise.resolve({ orderId: "o1" }),
  getPublicOrderStatus: () => Promise.resolve({ orderStatus: "open" }),
  cancelPublicOrder: () => Promise.resolve({ orderStatus: "cancelled" }),
  getActivePublicOrder: () => Promise.resolve(null),
}));
vi.mock("@/entities/cart", async (importOriginal) => ({
  ...(await importOriginal()),
  getPublicCart: () => Promise.resolve(null),
  savePublicCart: () => Promise.resolve({}),
  clearPublicCart: () => Promise.resolve({}),
}));
// Cliente sem endereço salvo: é o que leva o checkout direto ao formulário de
// endereço novo (onde mora a busca de CEP).
let lookupResult = { customerId: "c1", name: "Ana Ribeiro", addresses: [] };
vi.mock("@/entities/customer", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPublicCustomer: () => Promise.resolve(lookupResult),
}));
vi.mock("@/entities/store", async (importOriginal) => ({
  ...(await importOriginal()),
  getStoreInfo: () => Promise.resolve({ store: null }),
}));
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
    localStorage.clear();
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
    localStorage.clear();
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

// ---------------------------------------------------------------------------
// Busca de CEP no endereço novo (ViaCEP em shared/api/cep.js). O `fetch` global
// é o mock: a página e a normalização do ViaCEP correm de verdade, e o que o
// teste fixa é o comportamento do formulário (preencher, não sobrescrever,
// avisar sem travar).
const AVENIDA = { cep: "01310-100", logradouro: "Avenida Paulista", complemento: "lado ímpar", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" };
const PAULISTA = { cep: "05422-030", logradouro: "Rua Cardeal Arcoverde", complemento: "", bairro: "Pinheiros", localidade: "São Paulo", uf: "SP" };

const viaCep = (body) => ({ ok: true, status: 200, json: async () => body });
// Fetch que só rejeita quando o signal aborta — é o que o browser faz.
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const comSignal = (body, delayMs) => vi.fn((_url, { signal } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()));
    if (delayMs !== null) setTimeout(() => resolve(viaCep(body)), delayMs);
  })
);
// Busca presa no ar: só o abort a resolve — é a que estava em voo quando o
// cliente corrigiu o CEP.
const viaCepPreso = (body) => comSignal(body, null);
const viaCepLento = (body) => comSignal(body, 60);

let fetchMock;

async function abrirFormEndereco() {
  await renderPage();
  fireEvent.click(screen.getByLabelText("Ver Chopp 300ml"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByText("Adicionar ao carrinho"));
  await waitFor(() => expect(screen.getByText(/Ver carrinho/)).toBeTruthy());
  fireEvent.click(screen.getByText(/Ver carrinho/));
  await screen.findByText("Seu carrinho");
  fireEvent.click(screen.getByText(/Continuar/));
  await screen.findByText("Identificação");
  fireEvent.change(screen.getByPlaceholderText("(11) 99999-0000"), { target: { value: "11987654321" } });
  fireEvent.click(screen.getByText(/Continuar/));
  await screen.findByText("CEP"); // step new-address
}

const digitarCep = (value) => fireEvent.change(screen.getByLabelText("CEP"), { target: { value } });
const campo = (label) => screen.getByLabelText(label).value;

describe("CustomerMenuPage (busca de CEP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    currentMenu = baseMenu;
    lookupResult = { customerId: "c1", name: "Ana Ribeiro", addresses: [] };
    fetchMock = vi.fn(async () => viaCep(AVENIDA));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CEP válido preenche rua, bairro, cidade e estado", async () => {
    await abrirFormEndereco();
    digitarCep("01310100");

    await waitFor(() => expect(campo("Rua")).toBe("Avenida Paulista"));
    expect(campo("Bairro")).toBe("Bela Vista");
    expect(campo("Cidade")).toBe("São Paulo");
    expect(campo("Estado")).toBe("SP");
    // O complemento do ViaCEP ("lado ímpar") é faixa, não endereço: NUNCA
    // entra. O campo continua existindo e continua sendo digitado à mão.
    expect(campo("Complemento (opcional)")).toBe("");
    // número é sempre manual
    expect(campo("Número")).toBe("");
    expect(fetchMock.mock.calls[0][0]).toContain("01310100");
    expect(screen.queryByText("Buscando CEP…")).toBeNull();
  });

  it("não sobrescreve o que o cliente já digitou", async () => {
    await abrirFormEndereco();
    fireEvent.change(screen.getByLabelText("Bairro"), { target: { value: "Meu Bairro" } });
    digitarCep("01310100");

    await waitFor(() => expect(campo("Rua")).toBe("Avenida Paulista"));
    expect(campo("Bairro")).toBe("Meu Bairro");
  });

  it("complemento só é preenchido quando está vazio", async () => {
    await abrirFormEndereco();
    fireEvent.change(screen.getByLabelText("Complemento (opcional)"), { target: { value: "Apto 42" } });
    digitarCep("01310100");

    await waitFor(() => expect(campo("Rua")).toBe("Avenida Paulista"));
    expect(campo("Complemento (opcional)")).toBe("Apto 42");
  });

  it("CEP de município sem logradouro preenche pelo menos bairro e cidade", async () => {
    fetchMock.mockImplementation(async () => viaCep({ ...AVENIDA, logradouro: "", complemento: "" }));
    await abrirFormEndereco();
    digitarCep("01310100");

    await waitFor(() => expect(campo("Cidade")).toBe("São Paulo"));
    expect(campo("Bairro")).toBe("Bela Vista");
    expect(campo("Rua")).toBe("");
  });

  it("CEP não encontrado avisa, mas não trava o checkout", async () => {
    fetchMock.mockImplementation(async () => viaCep({ erro: true, logradouro: "" }));
    await abrirFormEndereco();
    digitarCep("99999999");

    await screen.findByText("CEP não encontrado. Confira o número.");
    // endereço à mão continua valendo e o botão não fica preso
    fireEvent.change(screen.getByLabelText("Rua"), { target: { value: "Rua Qualquer" } });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Bairro"), { target: { value: "Centro" } });
    fireEvent.change(screen.getByLabelText("Cidade"), { target: { value: "Recife" } });
    const botao = screen.getByText("Continuar").closest("button");
    expect(botao.disabled).toBe(false);
  });

  it("falha de rede avisa sem virar erro do checkout", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await abrirFormEndereco();
    digitarCep("01310100");

    await screen.findByText("Não foi possível buscar o CEP. Tente novamente.");
    expect(campo("Rua")).toBe("");
    // a mensagem é local ao campo: o banner global continua escondido
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it("aplica a máscara 00000-000", async () => {
    fetchMock.mockImplementation(viaCepPreso(AVENIDA));
    await abrirFormEndereco();
    digitarCep("013101002345");
    expect(campo("CEP")).toBe("01310-100");
    digitarCep("0131");
    expect(campo("CEP")).toBe("0131");
  });

  it("não busca com menos de 8 dígitos", async () => {
    await abrirFormEndereco();
    digitarCep("0131010");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400)); // passa do debounce
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounce: digitar rápido faz uma requisição só, do CEP final", async () => {
    await abrirFormEndereco();
    digitarCep("01310100");
    digitarCep("01310200"); // corrige antes do debounce vencer

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("01310200");
  });

  it("não repete a busca do mesmo CEP já buscado", async () => {
    await abrirFormEndereco();
    digitarCep("01310100");
    await waitFor(() => expect(campo("Rua")).toBe("Avenida Paulista"));

    // blur (rede de segurança do CEP colado) e redigitação do mesmo número
    fireEvent.blur(screen.getByLabelText("CEP"));
    digitarCep("01310100");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("corrigir o CEP no meio da busca cancela a resposta antiga", async () => {
    fetchMock.mockImplementationOnce(viaCepPreso(AVENIDA)).mockImplementationOnce(async () => viaCep(PAULISTA));
    await abrirFormEndereco();
    digitarCep("01310100");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    digitarCep("05422030");
    await waitFor(() => expect(campo("Rua")).toBe("Rua Cardeal Arcoverde"));

    // a primeira resposta chega tarde e é abortada: não pode sobrescrever
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(campo("Rua")).toBe("Rua Cardeal Arcoverde");
    expect(screen.queryByText(/Tente novamente/)).toBeNull();
  });

  it("mostra 'Buscando CEP…' enquanto a resposta não vem", async () => {
    fetchMock.mockImplementation(viaCepLento(AVENIDA));
    await abrirFormEndereco();
    digitarCep("01310100");

    await screen.findByText("Buscando CEP…");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(campo("Rua")).toBe("Avenida Paulista");
    expect(screen.queryByText("Buscando CEP…")).toBeNull();
  });

  it("a mensagem de erro sai quando o cliente corrige o CEP", async () => {
    fetchMock.mockImplementationOnce(async () => viaCep({ erro: true }));
    await abrirFormEndereco();
    digitarCep("99999999");
    await screen.findByText("CEP não encontrado. Confira o número.");

    digitarCep("0131010");
    expect(screen.queryByText("CEP não encontrado. Confira o número.")).toBeNull();
  });
});
