import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, FIXTURE } from "./helpers.js";

// Cadastro de produto: o que o ProductModal do gerente envia precisa
// sobreviver a create/update e voltar no payload (a tela "Em destaque na
// página de pedidos" depende disso — migration 0020).
//
// A propagação até o cardápio público é testada em self-service.test.ts, que
// liga o delivery; aqui é só o round-trip do cadastro.
describe("catálogo: destaque do produto", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  const novoProduto = (over: Record<string, unknown> = {}) => ({
    name: "Prato da Casa",
    description: "Teste",
    price: 32,
    categoryId: FIXTURE.category,
    ...over,
  });

  it("create sem featured nasce desmarcado (default da migration)", async () => {
    const res = await api("post", "/products", { token: manager, body: novoProduto() });
    expect(res.status).toBe(201);
    expect(res.json.featured).toBe(false);

    const listagem = await api("get", "/products", { token: manager });
    const achado = listagem.json.data.find((p: any) => p.id === res.json.id);
    expect(achado.featured).toBe(false);
  });

  it("create com featured marca, e o patch desmarca", async () => {
    const criado = await api("post", "/products", { token: manager, body: novoProduto({ featured: true }) });
    expect(criado.status).toBe(201);
    expect(criado.json.featured).toBe(true);

    const listagem = await api("get", "/products", { token: manager });
    expect(listagem.json.data.find((p: any) => p.id === criado.json.id).featured).toBe(true);

    const desmarca = await api("patch", `/products/${criado.json.id}`, { token: manager, body: { featured: false } });
    expect(desmarca.status).toBe(200);
    expect(desmarca.json.featured).toBe(false);
  });

  it("patch parcial não mexe no destaque quando o campo não vem", async () => {
    const criado = await api("post", "/products", { token: manager, body: novoProduto({ featured: true }) });
    const renomeado = await api("patch", `/products/${criado.json.id}`, { token: manager, body: { name: "Prato da Casa II" } });
    expect(renomeado.status).toBe(200);
    expect(renomeado.json.featured).toBe(true);
  });
});
