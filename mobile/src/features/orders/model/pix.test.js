
import { analyzePixKey, buildPixPayload, validarCnpj, validarCpf } from "./pix.js";

// Parser de TLV do próprio teste: a regressão que motivou a suíte é um
// comprimento com 3 dígitos (o campo "26" passando de 99 bytes), que
// desalinha a leitura do payload inteiro sem quebrar nenhuma asserção de
// string. Aqui todo campo declarado precisa bater com o tamanho real.
function parseTlv(payload) {
  const fields = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const length = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + length);
    fields.push({ id, length, value });
    i += 4 + length;
  }
  return fields;
}

function validarCrc(payload) {
  const semCrc = payload.slice(0, -4);
  return semCrc.endsWith("6304") && crc16(semCrc) === payload.slice(-4);
}

const encoder = new TextEncoder();
function crc16(payload) {
  const bytes = encoder.encode(payload);
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const BASE = {
  pixKey: "51991432485",
  merchantName: "Bar do Ze",
  merchantCity: "Sao Paulo",
  amount: 47.9,
  txid: "3f2b1c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
  description: "Mesa 12",
};

function campo(payload, id) {
  return parseTlv(payload).find((f) => f.id === id);
}

// A chave Pix é o subcampo "01" do campo 26, logo depois da GUI — que entra
// como o TLV "00"/14, então o parser só começa depois dela.
function chavePixDoPayload(payload) {
  const gui = "0014br.gov.bcb.pix";
  const conta = campo(payload, "26").value;
  expect(conta.startsWith(gui)).toBe(true);
  return parseTlv(conta.slice(gui.length)).find((f) => f.id === "01").value;
}

describe("BR Code — estrutura", () => {
  it("crc16 é o CCITT-FALSE (check value 29B1 para '123456789')", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("usa a GUI do Pix em minúsculas, como define o BACEN", () => {
    // Regressão: "BR.GOV.BCB.PIX" — leitores detectam o prefixo 0014br.gov.bcb.pix
    const payload = buildPixPayload(BASE);
    expect(payload.startsWith("00020126440014br.gov.bcb.pix")).toBe(true);
    expect(payload).not.toContain("BR.GOV.BCB.PIX");
    expect(campo(payload, "26").value.startsWith("0014br.gov.bcb.pix")).toBe(true);
  });

  it("fecha com o campo 63 e um CRC válido", () => {
    const payload = buildPixPayload(BASE);
    expect(campo(payload, "63")).toEqual({ id: "63", length: 4, value: payload.slice(-4) });
    expect(validarCrc(payload)).toBe(true);
  });

  it("todo campo TLV declara exatamente o tamanho que ocupa", () => {
    const payload = buildPixPayload(BASE);
    const fields = parseTlv(payload);
    // o cursor tem de consumir a string inteira — sobrar ou faltar byte
    // significa que algum comprimento está errado
    expect(fields.reduce((acc, f) => acc + 4 + f.value.length, 0)).toBe(payload.length);
    for (const f of fields) expect(f.value.length).toBe(f.length);
  });

  it("monta os campos 52/53/58 e o valor em 54", () => {
    const payload = buildPixPayload(BASE);
    expect(campo(payload, "52").value).toBe("0000");
    expect(campo(payload, "53").value).toBe("986");
    expect(campo(payload, "58").value).toBe("BR");
    expect(campo(payload, "54").value).toBe("47.90");
  });

  it("omite o campo 54 quando não há valor (QR sem valor fixo)", () => {
    const payload = buildPixPayload({ ...BASE, amount: null });
    expect(campo(payload, "54")).toBeUndefined();
    expect(validarCrc(payload)).toBe(true);
    expect(parseTlv(payload).every((f) => f.value.length === f.length)).toBe(true);
  });

  it("usa '***' no txid quando não há identificador", () => {
    const payload = buildPixPayload({ ...BASE, txid: "" });
    expect(campo(payload, "62").value).toBe("0503***");
    expect(validarCrc(payload)).toBe(true);
  });
});

describe("BR Code — txid", () => {
  // Regressão: order.id é crypto.randomUUID(), então vinha "3f2b1c4d-5e6f-..."
  // e o BACEN exige 1 a 25 caracteres ALFANUMÉRICOS.
  it("descarta o que não for alfanumérico e corta em 25", () => {
    const { value } = campo(buildPixPayload(BASE), "62");
    // "05" + tamanho 25 + os 25 primeiros hex do UUID, sem hífen, em maiúscula
    const esperado = BASE.txid.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 25);
    expect(esperado).toHaveLength(25);
    expect(value).toBe(`0525${esperado}`);
  });

  it("nunca gera txid com caractere fora de [A-Za-z0-9] nem acima de 25", () => {
    for (const txid of [
      "3f2b1c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
      "averyveryveryveryveryverylongidentifier-with-symbols-!@#",
      "MESA-12_PAGAMENTO#1",
      "***",
    ]) {
      const { value } = campo(buildPixPayload({ ...BASE, txid }), "62");
      const txidOut = value.slice(4);
      expect(txidOut).toMatch(/^[A-Za-z0-9*]+$/);
      expect(txidOut.length).toBeLessThanOrEqual(25);
    }
  });
});

describe("BR Code — limite de 99 bytes do TLV", () => {
  // Regressão: field() escrevia o comprimento sem ceiling. Com chave de
  // e-mail/EVP (36+ bytes) e descrição de 40, o campo 26 ficava com 129 bytes
  // e o cabeçalho saía "26129...", corrompendo o payload inteiro.
  it("corta a descrição para o que couber no campo 26", () => {
    const payload = buildPixPayload({
      ...BASE,
      pixKey: "fulano.telefone@banco.com.br",
      description: "Pedido 3f2b1c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d na mesa 12 do restaurante Unami",
    });
    expect(campo(payload, "26").length).toBeLessThanOrEqual(99);
    expect(parseTlv(payload).every((f) => f.value.length === f.length)).toBe(true);
    expect(validarCrc(payload)).toBe(true);
  });

  it("mantém os 40 bytes da descrição quando a chave é curta", () => {
    const payload = buildPixPayload({ ...BASE, description: "x".repeat(80) });
    expect(campo(payload, "26").value).toContain("02040x".slice(0, 2) + "40");
    expect(campo(payload, "26").value.slice(-40)).toBe("x".repeat(40));
  });

  it("recusa a chave que não cabe em 99 bytes, em vez de gerar payload quebrado", () => {
    expect(() => buildPixPayload({ ...BASE, pixKey: "a".repeat(80) })).toThrow(/longa demais/);
  });
});

describe("BR Code — ASCII e acentos", () => {
  it("remove acento do nome e da cidade sem quebrar o CRC", () => {
    const payload = buildPixPayload({ ...BASE, merchantName: "Bar do Zé", merchantCity: "São Leopoldo" });
    expect(campo(payload, "59").value).toBe("Bar do Ze");
    expect(campo(payload, "60").value).toBe("Sao Leopoldo");
    expect(validarCrc(payload)).toBe(true);
  });

  it("mantém o payload inteiro em ASCII imprimível", () => {
    // o travessão de orderLabel() ("—", 3 bytes UTF-8) saía cru no campo 26.02
    const payload = buildPixPayload({ ...BASE, description: "—" });
    expect(payload).toMatch(/^[\x20-\x7E]+$/);
    expect(validarCrc(payload)).toBe(true);
  });

  it("corta nome em 25 e cidade em 15 bytes", () => {
    const payload = buildPixPayload({
      ...BASE,
      merchantName: "Restaurante Extremely Longo",
      merchantCity: "Cidade Com Nome Bem Grande",
    });
    expect(campo(payload, "59").value.length).toBe(25);
    expect(campo(payload, "60").value.length).toBe(15);
    expect(validarCrc(payload)).toBe(true);
  });
});

describe("analyzePixKey", () => {
  it("deduz o tipo pelo formato e canonicaliza a chave", () => {
    expect(analyzePixKey("11144477735")).toMatchObject({ key: "11144477735", type: "cpf", warnings: [] });
    expect(analyzePixKey("11222333000181")).toMatchObject({ key: "11222333000181", type: "cnpj", warnings: [] });
    expect(analyzePixKey("fulano@banco.com.br")).toMatchObject({ key: "fulano@banco.com.br", type: "email" });
    expect(analyzePixKey("+55 51 99143-2485")).toMatchObject({ key: "+5551991432485", type: "phone" });
    expect(analyzePixKey("123e4567-e12b-12d1-a456-426655440000")).toMatchObject({
      key: "123e4567-e12b-12d1-a456-426655440000",
      type: "random",
    });
  });

  it("trata 10 dígitos como telefone nacional com DDD", () => {
    expect(analyzePixKey("5133334444")).toMatchObject({ key: "+555133334444", type: "phone" });
  });

  it("tira máscara de CPF, CNPJ e telefone", () => {
    expect(analyzePixKey("509.876.543-21").key).toBe("50987654321");
    expect(analyzePixKey("11.222.333/0001-81").key).toBe("11222333000181");
    expect(analyzePixKey("+55 (51) 99143-2485").key).toBe("+5551991432485");
    expect(analyzePixKey("5133334444").key).toBe("+555133334444");
  });

  it("avisa sobre dígito verificador inválido sem trocar o tipo", () => {
    // regressão de segurança: um CPF inválido NÃO pode virar chave de
    // telefone, ou o cliente pagaria para o número de outra pessoa
    const r = analyzePixKey("51991432485");
    expect(r.type).toBe("cpf");
    expect(r.key).toBe("51991432485");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/dígitos verificadores/);
  });

  it("trata chave vazia, letras e formato irreconhecível", () => {
    expect(analyzePixKey("")).toMatchObject({ key: "", type: null });
    expect(analyzePixKey("   ")).toMatchObject({ key: "", type: null });
    expect(analyzePixKey("abc")).toMatchObject({ type: null, warnings: [expect.stringMatching(/letras/)] });
    // 7 dígitos não casa com nenhum formato de chave Pix
    expect(analyzePixKey("1234567")).toMatchObject({
      type: null,
      warnings: [expect.stringMatching(/Não foi possível identificar/)],
    });
  });
});

// `pixKeyType` das configurações é a fonte da verdade: 11 dígitos são CPF e
// celular ao mesmo tempo, e chutar "CPF" fazia o telefone do gerente sair no
// BR Code sem DDI — o app do banco respondia "CPF inválido" e recusava o QR.
describe("analyzePixKey — tipo das configurações (pixKeyType)", () => {
  it("telefone de 11 dígitos sai em E.164, não como CPF", () => {
    const r = analyzePixKey("51991432485", "phone");
    expect(r).toMatchObject({ key: "+5551991432485", type: "phone", warnings: [] });
  });

  it("mesma chave, mesmo tipo salvo: o BR Code vai com o DDI", () => {
    // regressão do bug reportado: sem o tipo, 11 dígitos viravam CPF
    expect(chavePixDoPayload(buildPixPayload(BASE))).toBe("51991432485");
    const comTipo = buildPixPayload({ ...BASE, pixKeyType: "phone" });
    expect(chavePixDoPayload(comTipo)).toBe("+5551991432485");
    expect(validarCrc(comTipo)).toBe(true);
  });

  it("telefone com máscara, DDI digitado ou fixo", () => {
    expect(analyzePixKey("+55 (51) 99143-2485", "phone").key).toBe("+5551991432485");
    expect(analyzePixKey("5551991432485", "phone").key).toBe("+5551991432485");
    expect(analyzePixKey("5133334444", "phone").key).toBe("+555133334444");
    expect(analyzePixKey("+55 51 3333-4444", "phone").key).toBe("+555133334444");
  });

  it("11 dígitos fora do padrão de celular assume +55 e avisa", () => {
    // a intenção do gerente (tipo phone) manda, mas o formato é ambíguo
    const r = analyzePixKey("21255512345", "phone");
    expect(r).toMatchObject({ key: "+5521255512345", type: "phone" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/não começa por 9/);
  });

  it("CPF e CNPJ do tipo salvo perdem a máscara, e DV errado só avisa", () => {
    expect(analyzePixKey("509.876.543-21", "cpf")).toMatchObject({ key: "50987654321", type: "cpf" });
    const dv = analyzePixKey("51991432485", "cpf");
    expect(dv).toMatchObject({ key: "51991432485", type: "cpf" });
    expect(dv.warnings).toHaveLength(1);
    expect(dv.warnings[0]).toMatch(/dígitos verificadores do CPF/);
    expect(analyzePixKey("11.222.333/0001-81", "cnpj").key).toBe("11222333000181");
  });

  it("e-mail e chave aleatória do tipo salvo são canonicalizados", () => {
    expect(analyzePixKey(" Fulano.Telefone@Banco.com.BR ", "email")).toMatchObject({
      key: "fulano.telefone@banco.com.br",
      type: "email",
      warnings: [],
    });
    expect(analyzePixKey("123E4567-E12B-12D1-A456-426655440000", "random")).toMatchObject({
      key: "123e4567-e12b-12d1-a456-426655440000",
      type: "random",
    });
  });

  it("tipo incompatível com o valor cai na dedução e avisa", () => {
    // nunca no sentido inverso: tipo não pode "forçar" uma chave que não é dele
    const email = analyzePixKey("fulano@banco.com.br", "phone");
    expect(email).toMatchObject({ key: "fulano@banco.com.br", type: "email" });
    expect(email.warnings[0]).toMatch(/não é do tipo "Telefone"/);

    const fixo = analyzePixKey("5133334444", "cpf");
    expect(fixo).toMatchObject({ key: "+555133334444", type: "phone" });
    expect(fixo.warnings[0]).toMatch(/não é do tipo "CPF"/);
  });

  it("tipo desconhecido ou ausente não atrapalha a dedução", () => {
    const base = { key: "51991432485", type: "cpf" };
    expect(analyzePixKey("51991432485", undefined)).toMatchObject(base);
    expect(analyzePixKey("51991432485", null)).toMatchObject(base);
    expect(analyzePixKey("51991432485", "telefone")).toMatchObject(base);
  });
});

describe("validarCpf / validarCnpj", () => {
  it("aceita documentos com dígito verificador correto", () => {
    expect(validarCpf("11144477735")).toBe(true);
    expect(validarCpf("52998224725")).toBe(true);
    expect(validarCnpj("11222333000181")).toBe(true);
    expect(validarCnpj("11444777000161")).toBe(true);
  });

  it("recusa dígito verificador errado, tamanho errado e sequências inválidas", () => {
    expect(validarCpf("51991432485")).toBe(false);
    expect(validarCpf("11111111112")).toBe(false);
    expect(validarCpf("1114447773")).toBe(false);
    expect(validarCnpj("11222333000182")).toBe(false);
    expect(validarCnpj("1122233300018")).toBe(false);
  });
});
