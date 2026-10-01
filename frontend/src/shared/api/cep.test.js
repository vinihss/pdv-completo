import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAddressByCep } from "./cep.js";

// O ViaCEP é o terceiro que normaliza: o teste fixa os três `code` que a tela
// distingue (`not_found`, `invalid`, `network`) e o formato do objeto devolvido,
// que é o vocabulário do formulário de endereço — não o do ViaCEP.
const json = (body, { ok = true, status = 200 } = {}) =>
  vi.fn().mockResolvedValue({ ok, status, json: async () => body });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAddressByCep", () => {
  it("normaliza a resposta para os campos do formulário", async () => {
    const fetchMock = json({
      cep: "01310-100",
      logradouro: "Avenida Paulista",
      complemento: "de lado ímpar",
      bairro: "Bela Vista",
      localidade: "São Paulo",
      uf: "SP",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAddressByCep("01310100")).resolves.toEqual({
      cep: "01310-100",
      street: "Avenida Paulista",
      neighborhood: "Bela Vista",
      city: "São Paulo",
      complement: "de lado ímpar",
    });
    // só dígitos no caminho e nada de token da sessão: serviço público
    expect(fetchMock).toHaveBeenCalledWith("https://viacep.com.br/ws/01310100/json/", {
      signal: undefined,
    });
  });

  it("CEP de município volta sem logradouro, e isso não é erro", async () => {
    vi.stubGlobal("fetch", json({ cep: "69900-000", logradouro: "", complemento: "", bairro: "Centro", localidade: "Rio Branco", uf: "AC" }));
    const found = await fetchAddressByCep("69900000");
    expect(found.street).toBe("");
    expect(found.neighborhood).toBe("Centro");
    expect(found.city).toBe("Rio Branco");
  });

  it("erro: true vira not_found", async () => {
    vi.stubGlobal("fetch", json({ erro: true, logradouro: "" }));
    await expect(fetchAddressByCep("99999999")).rejects.toMatchObject({ code: "not_found" });
  });

  it("CEP incompleto nem sai para a rede", async () => {
    const fetchMock = json({});
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAddressByCep("0131010")).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha de rede e resposta ilegível viram network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchAddressByCep("01310100")).rejects.toMatchObject({ code: "network" });

    vi.stubGlobal("fetch", json({}, { ok: false, status: 503 }));
    await expect(fetchAddressByCep("01310100")).rejects.toMatchObject({ code: "network" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("ruim"); } }));
    await expect(fetchAddressByCep("01310100")).rejects.toMatchObject({ code: "network" });
  });
});