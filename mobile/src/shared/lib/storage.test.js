// Novo: contrato do shim de storage (MMKV) — é dele que os módulos copiados
// do web dependem com a API de `localStorage`.
import { storage } from "./storage.js";

describe("storage (shim localStorage sobre MMKV)", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("getItem devolve null para chave ausente", () => {
    expect(storage.getItem("nao-existe")).toBe(null);
  });

  it("guarda e lê o mesmo valor", () => {
    storage.setItem("pdv:server", "http://192.168.0.10:3000");
    expect(storage.getItem("pdv:server")).toBe("http://192.168.0.10:3000");
  });

  it("removeItem apaga e volta a null", () => {
    storage.setItem("k", "v");
    storage.removeItem("k");
    expect(storage.getItem("k")).toBe(null);
  });

  it("clear limpa tudo", () => {
    storage.setItem("a", "1");
    storage.setItem("b", "2");
    storage.clear();
    expect(storage.getItem("a")).toBe(null);
    expect(storage.getItem("b")).toBe(null);
  });
});