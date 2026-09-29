import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, raw } from "./helpers.js";

// Chave Pix canônica no cadastro (docs/11-pix-pendencias.md §3.1).
//
// O BR Code é gerado no client, mas o `pixKeyType` que o gerente salva em
// Configurações é o que desempata os 11 dígitos: CPF e celular no formato
// nacional têm exatamente o mesmo formato, e sem o tipo o telefone ia para o
// QR sem DDI — o app do banco respondia "CPF inválido".
//
// `resetState()` mantém a linha de `store_settings` (as outras suítes dependem
// dos toggles de rollout), então esta suíte devolve a chave ao default no
// `afterAll` — e o nome/cidade não podem mudar, senão o usecase dispara o
// geocoding do Nominatim (efeito colateral nada a ver com Pix).
describe("store settings: chave Pix canônica", () => {
  beforeAll(() => seedFixture());
  afterAll(async () => {
    await closeTestApp();
    await raw.exec(`UPDATE store_settings SET pix_key = '', pix_key_type = 'phone'`);
  });
  beforeEach(() => resetState());

  async function salvarChave(pixKey: string, pixKeyType: string) {
    const atual = await api("get", "/store-settings", { token: manager });
    const res = await api("put", "/store-settings", {
      token: manager,
      body: { ...atual.json, pixKey, pixKeyType },
    });
    expect(res.status).toBe(200);
    return res;
  }

  function chaveNoBanco() {
    return raw.get(`SELECT pix_key, pix_key_type FROM store_settings WHERE id = 'singleton'`);
  }

  it("telefone de 11 dígitos grava com o DDI — o bug do 'CPF inválido'", async () => {
    const res = await salvarChave("51991432485", "phone");
    expect(res.json.pixKey).toBe("+5551991432485");
    expect(res.json.pixKeyType).toBe("phone");

    const linha = await chaveNoBanco();
    expect(linha.pix_key).toBe("+5551991432485");
    expect(linha.pix_key_type).toBe("phone");
  });

  it("telefone com máscara, DDI já digitado ou fixo", async () => {
    expect((await salvarChave("+55 (51) 99143-2485", "phone")).json.pixKey).toBe("+5551991432485");
    expect((await salvarChave("5551991432485", "phone")).json.pixKey).toBe("+5551991432485");
    expect((await salvarChave("5133334444", "phone")).json.pixKey).toBe("+555133334444");
    expect((await salvarChave("  51 99143 2485  ", "phone")).json.pixKey).toBe("+5551991432485");
  });

  it("CPF/CNPJ do tipo salvo perdem a máscara, e DV inválido não recusa o save", async () => {
    // 51991432485 não é um CPF existente: o save tem de passar, senão o
    // gerente fica sem conseguir salvar o resto das configurações
    expect((await salvarChave("519.914.324-85", "cpf")).json.pixKey).toBe("51991432485");
    expect((await salvarChave("11.222.333/0001-81", "cnpj")).json.pixKey).toBe("11222333000181");
  });

  it("e-mail em minúsculas e chave aleatória", async () => {
    expect((await salvarChave(" Fulano.Telefone@Banco.com.BR ", "email")).json.pixKey).toBe(
      "fulano.telefone@banco.com.br",
    );
    expect((await salvarChave("123E4567-E12B-12D1-A456-426655440000", "random")).json.pixKey).toBe(
      "123e4567-e12b-12d1-a456-426655440000",
    );
  });

  it("chave incompatível com o tipo fica como veio, sem quebrar o save", async () => {
    const res = await salvarChave("fulano@banco.com.br", "phone");
    expect(res.json.pixKey).toBe("fulano@banco.com.br");
    // a divergência vira aviso na geração do QR, não erro aqui
    expect((await chaveNoBanco()).pix_key).toBe("fulano@banco.com.br");

    expect((await salvarChave("abc", "phone")).json.pixKey).toBe("abc");
    expect((await salvarChave("51 3333-4444", "cpf")).json.pixKey).toBe("51 3333-4444");
  });

  it("chave vazia continua vazia (Pix desligado)", async () => {
    expect((await salvarChave("", "phone")).json.pixKey).toBe("");
    expect((await chaveNoBanco()).pix_key).toBe("");
  });
});
