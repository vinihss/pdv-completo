import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, testApp, manager, cashier, waiter, FIXTURE } from "./helpers.js";

// Manutenção de clientes (gerente e caixa) e perfil completo de equipe:
// telefone, email, foto e PIN manual — além da busca por nome ignorando
// acentos (extensão unaccent, migration 0003).

describe("manutenção de clientes (gerente e caixa)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("gerente cria cliente com telefone e email, e o caixa enxerga", async () => {
    const criado = await api("post", "/customers", {
      token: manager,
      body: { name: "Maria Silva", phone: "11987654321", email: "maria@exemplo.com" },
    });
    expect(criado.status).toBe(201);
    expect(criado.json.name).toBe("Maria Silva");
    expect(criado.json.phone).toBe("11987654321");
    expect(criado.json.email).toBe("maria@exemplo.com");
    expect(criado.json.active).toBe(true);

    const lista = await api("get", "/customers", { token: cashier });
    expect(lista.status).toBe(200);
    expect(lista.json.data.some((c: any) => c.id === criado.json.id)).toBe(true);
  });

  it("garçom não acessa a manutenção (lista/detalhe/update 403), mas cria cliente no balcão", async () => {
    const lista = await api("get", "/customers", { token: waiter });
    expect(lista.status).toBe(403);
    const detalhe = await api("get", "/customers/qualquer-id", { token: waiter });
    expect(detalhe.status).toBe(403);

    // Criar é operação de balcão (garçom abre comanda com cliente).
    const cria = await api("post", "/customers", { token: waiter, body: { name: "Cliente Balcão" } });
    expect(cria.status).toBe(201);

    // Busca leve do garçom continua liberada.
    const busca = await api("get", "/customers/search?q=balc", { token: waiter });
    expect(busca.status).toBe(200);
  });

  it("busca por nome ignora acentos e case", async () => {
    await api("post", "/customers", { token: manager, body: { name: "José da Silva", phone: "11911112222" } });

    for (const term of ["jose", "José", "JOSÉ", "silva", "SILVA"]) {
      const res = await api("get", `/customers?search=${encodeURIComponent(term)}`, { token: manager });
      expect(res.json.data.some((c: any) => c.name === "José da Silva")).toBe(true);
    }
  });

  it("busca também acha por telefone e email", async () => {
    await api("post", "/customers", {
      token: manager,
      body: { name: "Carlos Pereira", phone: "11999998888", email: "carlos.p@exemplo.com" },
    });
    const porTelefone = await api("get", "/customers?search=999998888", { token: manager });
    expect(porTelefone.json.data.some((c: any) => c.name === "Carlos Pereira")).toBe(true);
    const porEmail = await api("get", "/customers?search=carlos.p", { token: manager });
    expect(porEmail.json.data.some((c: any) => c.name === "Carlos Pereira")).toBe(true);
  });

  it("PATCH atualiza campos e desativa/reativa (soft delete)", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Ana", phone: "11912345678" } });

    const atualizado = await api("patch", `/customers/${criado.json.id}`, {
      token: manager,
      body: { name: "Ana Souza", phone: "11987651234" },
    });
    expect(atualizado.status).toBe(200);
    expect(atualizado.json.name).toBe("Ana Souza");
    expect(atualizado.json.phone).toBe("11987651234");

    const desativado = await api("patch", `/customers/${criado.json.id}`, { token: manager, body: { active: false } });
    expect(desativado.json.active).toBe(false);

    const listaAtivos = await api("get", "/customers?active=true", { token: manager });
    expect(listaAtivos.json.data.some((c: any) => c.id === criado.json.id)).toBe(false);
    const listaInativos = await api("get", "/customers?active=false", { token: manager });
    expect(listaInativos.json.data.some((c: any) => c.id === criado.json.id)).toBe(true);

    const reativado = await api("patch", `/customers/${criado.json.id}`, { token: manager, body: { active: true } });
    expect(reativado.json.active).toBe(true);
  });

  it("email duplicado é rejeitado no create e no update", async () => {
    await api("post", "/customers", { token: manager, body: { name: "A", email: "dup@exemplo.com" } });
    const duplicado = await api("post", "/customers", { token: manager, body: { name: "B", email: "dup@exemplo.com" } });
    expect(duplicado.status).toBe(400);
    expect(duplicado.json.error.code).toBe("validation_failed");

    const outro = await api("post", "/customers", { token: manager, body: { name: "C", email: "outro@exemplo.com" } });
    const colide = await api("patch", `/customers/${outro.json.id}`, { token: manager, body: { email: "dup@exemplo.com" } });
    expect(colide.status).toBe(400);
  });

  it("GET /customers/:id traz o cliente com endereços", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Detalhe" } });
    const res = await api("get", `/customers/${criado.json.id}`, { token: manager });
    expect(res.status).toBe(200);
    expect(res.json.addresses).toEqual([]);

    const inexistente = await api("get", "/customers/nao-existe", { token: manager });
    expect(inexistente.status).toBe(404);
  });
});

describe("perfil completo de equipe (telefone, email, PIN manual)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("cria usuário com telefone e email; update altera perfil, telefone e email", async () => {
    const criado = await api("post", "/users", {
      token: manager,
      body: { name: "Novo Garçom", role: "waiter", phone: "11977776666", email: "novo@exemplo.com" },
    });
    expect(criado.status).toBe(201);
    expect(criado.json.phone).toBe("11977776666");
    expect(criado.json.email).toBe("novo@exemplo.com");
    expect(criado.json.pin).toBeTruthy(); // PIN em plaintext, uma exibição

    const atualizado = await api("patch", `/users/${criado.json.id}`, {
      token: manager,
      body: { phone: "11966665555", email: "novo2@exemplo.com", role: "cashier" },
    });
    expect(atualizado.status).toBe(200);
    expect(atualizado.json.phone).toBe("11966665555");
    expect(atualizado.json.email).toBe("novo2@exemplo.com");
    expect(atualizado.json.role).toBe("cashier");
  });

  it("PIN manual definido no update permite login; PIN fora do tamanho é rejeitado", async () => {
    const criado = await api("post", "/users", { token: manager, body: { name: "Pin Manual", role: "waiter" } });

    const fixado = await api("patch", `/users/${criado.json.id}`, { token: manager, body: { pin: "4321" } });
    expect(fixado.status).toBe(200);

    const login = await api("post", "/auth/login", { body: { userId: criado.json.id, pin: "4321" } });
    expect(login.status).toBe(200);
    expect(login.json.token).toBeTruthy();

    const curto = await api("patch", `/users/${criado.json.id}`, { token: manager, body: { pin: "12" } });
    expect(curto.status).toBe(400);
  });

  it("email duplicado entre usuários é rejeitado", async () => {
    await api("post", "/users", { token: manager, body: { name: "U1", role: "waiter", email: "eq@exemplo.com" } });
    const dup = await api("post", "/users", { token: manager, body: { name: "U2", role: "waiter", email: "eq@exemplo.com" } });
    expect(dup.status).toBe(400);
  });

  it("foto: upload grava photo_path e delete remove", async () => {
    const criado = await api("post", "/users", { token: manager, body: { name: "Com Foto", role: "waiter" } });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    // inject multipart: o light-my-request 6.x só monta o body quando o
    // payload é um FormData (o helper api só cobre JSON).
    const app = await testApp();
    const form = new FormData();
    form.append("photo", new Blob([png], { type: "image/png" }), "foto.png");
    const upload = await app.inject({
      method: "POST",
      url: `/users/${criado.json.id}/photo`,
      headers: { authorization: `Bearer ${manager}` },
      payload: form,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().photoPath).toBe(`/uploads/${criado.json.id}.png`);

    const lista = await api("get", "/users", { token: manager });
    const eu = lista.json.find((u: any) => u.id === criado.json.id);
    expect(eu.photoPath).toBe(`/uploads/${criado.json.id}.png`);

    const remove = await api("delete", `/users/${criado.json.id}/photo`, { token: manager });
    expect(remove.status).toBe(200);
    expect(remove.json.photoPath).toBeNull();
  });
});

describe("busca de produtos ignora acentos", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("'cerveja' acha 'Cerveja' e 'CERVEJA' (unaccent)", async () => {
    await api("post", "/products", {
      token: manager,
      body: { name: "Cerveja", price: 8, categoryId: FIXTURE.category },
    });
    await api("post", "/products", {
      token: manager,
      body: { name: "Açaí", price: 12, categoryId: FIXTURE.category },
    });

    for (const term of ["cerveja", "CERVEJA", "Cerveja"]) {
      const res = await api("get", `/products?q=${encodeURIComponent(term)}`, { token: manager });
      expect(res.json.data.some((p: any) => p.name === "Cerveja")).toBe(true);
    }
    for (const term of ["açaí", "acai", "AÇAÍ"]) {
      const res = await api("get", `/products?q=${encodeURIComponent(term)}`, { token: manager });
      expect(res.json.data.some((p: any) => p.name === "Açaí")).toBe(true);
    }
  });
});
