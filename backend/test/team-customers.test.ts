import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, testApp, manager, cashier, waiter, kitchen, raw, FIXTURE } from "./helpers.js";

// Manutenção de clientes (gerente e caixa) e perfil completo de equipe:
// telefone, email, foto e PIN manual — além da busca por nome ignorando
// acentos (extensão unaccent, migration 0003).
//
// A partir de 0008 entra o DETALHE de cliente: CPF com dígito verificador,
// observações, foto, histórico de comandas e a série de consumo do gráfico.

// ---------- Helpers do bloco de detalhe ----------

async function novoCliente(body: Record<string, unknown>): Promise<string> {
  const res = await api("post", "/customers", { token: manager, body: { name: "Cliente do Detalhe", ...body } });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

// Comanda no fluxo completo (ordered → ready → delivered → paga → fechada).
// Pix confirmado de propósito: dinheiro exigiria um caixa aberto, e o que
// está em teste aqui é o histórico/gráfico do cliente, não a gaveta.
async function comandaFechada(customerId: string, quantity = 2): Promise<string> {
  const aberta = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), customerId },
  });
  expect(aberta.status).toBe(201);
  const orderId: string = aberta.json.id;

  const itens = await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity }] },
  });
  expect(itens.status).toBe(201);
  const itemId: string = itens.json.data[0].id;

  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: kitchen,
    body: { status: "ready", expectedVersion: 1 },
  });
  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: waiter,
    body: { status: "delivered", expectedVersion: 2 },
  });
  // 2 × R$ 9,50 = R$ 19,00 (produto da fixture).
  await api("put", `/orders/${orderId}/payments`, {
    token: waiter,
    body: { payments: [{ method: "pix", amount: 19, confirmed: true }] },
  });
  const fechada = await api("patch", `/orders/${orderId}/close`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID() },
  });
  expect(fechada.status).toBe(200);
  return orderId;
}

async function comandaAberta(customerId: string, quantity = 1): Promise<string> {
  const aberta = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), customerId },
  });
  expect(aberta.status).toBe(201);
  const orderId: string = aberta.json.id;
  await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity }] },
  });
  return orderId;
}

// Empurra o `closed_at` para outro dia — o fechamento grava "agora", e o
// gráfico precisa de dias distintos para provar o agrupamento.
async function moverFechamento(orderId: string, closedAt: string) {
  await raw.all(`UPDATE "order" SET closed_at = $1 WHERE id = $2 RETURNING id`, [closedAt, orderId]);
}

// `YYYY-MM-DD` de `daysAgo` atrás no relógio LOCAL do offset informado.
function diaLocal(offsetMinutes: number, daysAgo = 0): string {
  const localMs = Date.now() + offsetMinutes * 60_000 - daysAgo * 86_400_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

// ISO de um instante às 20h do dia local de `daysAgo` atrás.
function iso20hLocal(offsetMinutes: number, daysAgo = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000 - daysAgo * 86_400_000);
  const local20h = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0);
  return new Date(local20h - offsetMinutes * 60_000).toISOString();
}

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
    expect(res.json.openOrders).toEqual([]);

    const inexistente = await api("get", "/customers/nao-existe", { token: manager });
    expect(inexistente.status).toBe(404);
  });

  it("endereço criado no balcão guarda a UF e ela volta no detalhe (0006)", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Com UF" } });
    const endereco = await api("post", `/customers/${criado.json.id}/addresses`, {
      token: manager,
      body: {
        street: "Rua das Flores",
        number: "100",
        neighborhood: "Centro",
        city: "Campinas",
        state: "SP",
      },
    });
    expect(endereco.status).toBe(201);
    expect(endereco.json.state).toBe("SP");

    // O detalhe serializava o endereço SEM a UF, então o cadastro manual
    // perdia o dado que a rota pública de endereço devolvia.
    const detalhe = await api("get", `/customers/${criado.json.id}`, { token: manager });
    expect(detalhe.json.addresses[0].state).toBe("SP");
  });
});

describe("detalhe de cliente — CPF, observações e foto (0008)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("cria com CPF e observações, e o detalhe devolve os dois", async () => {
    const criado = await api("post", "/customers", {
      token: manager,
      body: { name: "Maria CPF", cpf: "52998224725", notes: "Pede sem cebola" },
    });
    expect(criado.status).toBe(201);
    expect(criado.json.cpf).toBe("52998224725");
    expect(criado.json.notes).toBe("Pede sem cebola");
    expect(criado.json.photoPath).toBeNull();

    const detalhe = await api("get", `/customers/${criado.json.id}`, { token: manager });
    expect(detalhe.status).toBe(200);
    expect(detalhe.json.cpf).toBe("52998224725");
    expect(detalhe.json.notes).toBe("Pede sem cebola");

    // CPF e observações também no PATCH (a tela edita e salva no mesmo form).
    const editado = await api("patch", `/customers/${criado.json.id}`, {
      token: manager,
      body: { cpf: "11144477735", notes: "  Mesa preferida 4  " },
    });
    expect(editado.status).toBe(200);
    expect(editado.json.cpf).toBe("11144477735");
    expect(editado.json.notes).toBe("Mesa preferida 4"); // aparado
  });

  it("CPF com dígito verificador errado é recusado (400) e o cliente não nasce", async () => {
    // 529.982.247-25 é válido; o último dígito virado já não fecha.
    const res = await api("post", "/customers", { token: manager, body: { name: "CPF Ruim", cpf: "52998224726" } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
    expect(res.json.error.details.field).toBe("cpf");

    const lista = await api("get", "/customers?search=CPF Ruim", { token: manager });
    expect(lista.json.data).toHaveLength(0);

    // O clássico "11111111111" fecha no módulo 11 mas não é CPF de ninguém.
    const repetido = await api("post", "/customers", { token: manager, body: { name: "CPF Repetido", cpf: "11111111111" } });
    expect(repetido.status).toBe(400);

    // Menos de 11 dígitos também não passa.
    const curto = await api("post", "/customers", { token: manager, body: { name: "CPF Curto", cpf: "1234567890" } });
    expect(curto.status).toBe(400);
  });

  it("CPF duplicado em outro cliente é recusado no create e no update", async () => {
    const primeiro = await api("post", "/customers", { token: manager, body: { name: "Titular", cpf: "52998224725" } });
    expect(primeiro.status).toBe(201);

    const duplicado = await api("post", "/customers", { token: manager, body: { name: "Falso", cpf: "52998224725" } });
    expect(duplicado.status).toBe(400);
    expect(duplicado.json.error.code).toBe("validation_failed");
    expect(duplicado.json.error.details.field).toBe("cpf");

    // O mesmo cliente reenviando o próprio CPF não colide com ele mesmo.
    const mesmo = await api("patch", `/customers/${primeiro.json.id}`, {
      token: manager,
      body: { cpf: "52998224725", notes: "só mudou a observação" },
    });
    expect(mesmo.status).toBe(200);

    const outro = await api("post", "/customers", { token: manager, body: { name: "Terceiro" } });
    const colide = await api("patch", `/customers/${outro.json.id}`, { token: manager, body: { cpf: "52998224725" } });
    expect(colide.status).toBe(400);
  });

  it("cpf ausente ou vazio continua aceito e grava null (cliente existente não quebra)", async () => {
    const semCampo = await api("post", "/customers", { token: manager, body: { name: "Sem CPF" } });
    expect(semCampo.status).toBe(201);
    expect(semCampo.json.cpf).toBeNull();

    const vazio = await api("post", "/customers", { token: manager, body: { name: "CPF Vazio", cpf: "", notes: "" } });
    expect(vazio.status).toBe(201);
    expect(vazio.json.cpf).toBeNull();
    expect(vazio.json.notes).toBeNull();

    // Dois clientes sem CPF convivem: o índice é parcial (WHERE cpf IS NOT NULL).
    const outro = await api("post", "/customers", { token: manager, body: { name: "Outro Sem CPF" } });
    expect(outro.status).toBe(201);
  });

  it("cpf enviado com máscara é gravado com os 11 dígitos crus", async () => {
    const criado = await api("post", "/customers", {
      token: manager,
      body: { name: "Com Mascara", cpf: "529.982.247-25" },
    });
    expect(criado.status).toBe(201);
    expect(criado.json.cpf).toBe("52998224725");

    const doBanco = await raw.get("SELECT cpf FROM customer WHERE id = $1", [criado.json.id]);
    expect(doBanco.cpf).toBe("52998224725");

    // A máscara é apresentação: o índice e a comparação são nos dígitos.
    const peloCru = await api("get", "/customers/nao-existe", { token: manager });
    expect(peloCru.status).toBe(404);
  });

  it("foto do cliente: upload grava photo_path, formato inválido é 400 e delete limpa", async () => {
    const id = await novoCliente({ name: "Com Foto" });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    // inject multipart: o light-my-request 6.x só monta o body quando o
    // payload é um FormData (o helper api só cobre JSON).
    const app = await testApp();
    const form = new FormData();
    form.append("photo", new Blob([png], { type: "image/png" }), "minha-foto.png");
    const upload = await app.inject({
      method: "POST",
      url: `/customers/${id}/photo`,
      headers: { authorization: `Bearer ${manager}` },
      payload: form,
    });
    expect(upload.statusCode).toBe(200);
    // O nome do arquivo vem do APP (`<id>.<ext>`), não do "minha-foto.png" enviado.
    expect(upload.json().photoPath).toBe(`/uploads/customer/${id}.png`);

    const detalhe = await api("get", `/customers/${id}`, { token: manager });
    expect(detalhe.json.photoPath).toBe(`/uploads/customer/${id}.png`);

    // GIF não está na lista de MIME aceitos da rota.
    const gif = new FormData();
    gif.append("photo", new Blob([Buffer.from("GIF89a")], { type: "image/gif" }), "anim.gif");
    const invalido = await app.inject({
      method: "POST",
      url: `/customers/${id}/photo`,
      headers: { authorization: `Bearer ${manager}` },
      payload: gif,
    });
    expect(invalido.statusCode).toBe(400);
    expect(invalido.json().error.code).toBe("validation_failed");

    const remove = await api("delete", `/customers/${id}/photo`, { token: manager });
    expect(remove.status).toBe(200);
    expect(remove.json.photoPath).toBeNull();

    const depois = await api("get", `/customers/${id}`, { token: manager });
    expect(depois.json.photoPath).toBeNull();
  });

  it("foto: cliente inexistente é 404 e o garçom é 403", async () => {
    const semCliente = await api("delete", "/customers/nao-existe/photo", { token: manager });
    expect(semCliente.status).toBe(404);

    const id = await novoCliente({ name: "So Gerencia" });
    const garcom = await api("post", `/customers/${id}/photo`, { token: waiter });
    expect(garcom.status).toBe(403);
  });
});

describe("detalhe de cliente — comanda aberta, histórico e gráfico", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("GET /customers/:id lista as comandas abertas do cliente (alerta de conta em aberto)", async () => {
    const id = await novoCliente({ name: "Com Conta Aberta" });
    const emAberto = await comandaAberta(id, 2); // 2 × 9,50 = 19,00

    const outra = await novoCliente({ name: "Sem Conta" });
    await comandaFechada(outra);

    const detalhe = await api("get", `/customers/${id}`, { token: manager });
    expect(detalhe.json.openOrders).toHaveLength(1);
    expect(detalhe.json.openOrders[0]).toMatchObject({ id: emAberto, status: "open", total: 19 });
    expect(typeof detalhe.json.openOrders[0].openedAt).toBe("string");

    // Cliente sem comanda em aberto volta com lista vazia, não com erro.
    const semAberto = await api("get", `/customers/${outra}`, { token: manager });
    expect(semAberto.json.openOrders).toEqual([]);
  });

  it("GET /customers/:id/orders pagina, ordena por mais recente e põe a comanda aberta por último", async () => {
    const id = await novoCliente({ name: "Historico" });
    const antiga = await comandaFechada(id); // 19,00
    const recente = await comandaFechada(id);
    const emAberto = await comandaAberta(id);
    await moverFechamento(antiga, iso20hLocal(0, 10));
    await moverFechamento(recente, iso20hLocal(0, 2));

    const tudo = await api("get", `/customers/${id}/orders`, { token: manager });
    expect(tudo.status).toBe(200);
    expect(tudo.json.total).toBe(3);
    expect(tudo.json.data.map((o: any) => o.id)).toEqual([recente, antiga, emAberto]);

    // `closed_at` DESC NULLS LAST: sem o NULLS LAST a comanda em aberto (que
    // não tem closed_at) abriria a lista de um histórico de visitas passadas.
    expect(tudo.json.data[2].status).toBe("open");
    expect(tudo.json.data[2].closedAt).toBeNull();

    // Cada item já vem pronto pra renderizar (total, contagem, mesa, pagamento).
    expect(tudo.json.data[0]).toMatchObject({
      id: recente,
      status: "closed",
      tableNumber: null,
      paymentMethod: "pix",
      total: 19,
      itemCount: 2,
    });
    expect(tudo.json.data[0].closedAt).toBeTruthy();

    // Paginação de verdade: a página 2 não repete a página 1 e o total não muda.
    const primeira = await api("get", `/customers/${id}/orders?limit=2&offset=0`, { token: manager });
    const segunda = await api("get", `/customers/${id}/orders?limit=2&offset=2`, { token: manager });
    expect(primeira.json.data.map((o: any) => o.id)).toEqual([recente, antiga]);
    expect(segunda.json.data.map((o: any) => o.id)).toEqual([emAberto]);
    expect(primeira.json.total).toBe(3);
    expect(segunda.json.total).toBe(3);

    // Cliente inexistente é 404 nas duas leituras.
    const sumiu = await api("get", "/customers/nao-existe/orders", { token: manager });
    expect(sumiu.status).toBe(404);
  });

  it("orders aceita filtro de dia (drill-down do gráfico) e ele conta no total", async () => {
    const id = await novoCliente({ name: "Drill Down" });
    const antiga = await comandaFechada(id);
    const recente = await comandaFechada(id);
    await moverFechamento(antiga, iso20hLocal(-180, 10));
    await moverFechamento(recente, iso20hLocal(-180, 2));

    // Filtro no servidor, e não na página: filtrar no cliente sobre os 20 itens
    // da primeira página esconderia as comandas mais antigas do mesmo dia.
    const dia = await api(
      "get",
      `/customers/${id}/orders?from=${diaLocal(-180, 2)}&to=${diaLocal(-180, 2)}&tz=-03:00`,
      { token: manager }
    );
    expect(dia.status).toBe(200);
    expect(dia.json.data.map((o: any) => o.id)).toEqual([recente]);
    expect(dia.json.total).toBe(1);

    const diaVazio = await api(
      "get",
      `/customers/${id}/orders?from=${diaLocal(-180, 3)}&to=${diaLocal(-180, 3)}&tz=-03:00`,
      { token: manager }
    );
    expect(diaVazio.json.data).toEqual([]);
    expect(diaVazio.json.total).toBe(0);

    // Sem filtro continua vindo tudo.
    const tudo = await api("get", `/customers/${id}/orders`, { token: manager });
    expect(tudo.json.total).toBe(2);

    const dataInvalida = await api("get", `/customers/${id}/orders?from=01-01-2026`, { token: manager });
    expect(dataInvalida.status).toBe(400);
  });

  it("item cancelado não entra no total do histórico", async () => {
    const id = await novoCliente({ name: "Com Cancelado" });
    const aberta = await api("post", "/orders", { token: waiter, body: { correlationId: crypto.randomUUID(), customerId: id } });
    const orderId: string = aberta.json.id;
    const itens = await api("post", `/orders/${orderId}/items`, {
      token: waiter,
      body: {
        correlationId: crypto.randomUUID(),
        items: [
          { productId: FIXTURE.product, quantity: 2 },
          { productId: FIXTURE.product, quantity: 1 },
        ],
      },
    });
    // Estado alcançado pelo cancelamento da comanda. Escrito direto porque o
    // caminho da API para ele (cancelar a comanda) não deixa a comanda fechada —
    // e o que se quer provar aqui é a REGRA do relatório, não o cancelamento.
    await raw.all(`UPDATE order_item SET status = 'cancelled' WHERE id = $1`, [itens.json.data[1].id]);

    const itemId: string = itens.json.data[0].id;
    await api("patch", `/orders/${orderId}/items/${itemId}`, { token: kitchen, body: { status: "ready", expectedVersion: 1 } });
    await api("patch", `/orders/${orderId}/items/${itemId}`, { token: waiter, body: { status: "delivered", expectedVersion: 2 } });
    // 19,00 = só o que sobrou; com o cancelado seriam 28,50 e o caixa não fecharia.
    await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "pix", amount: 19, confirmed: true }] },
    });
    const fechada = await api("patch", `/orders/${orderId}/close`, { token: waiter, body: { correlationId: crypto.randomUUID() } });
    expect(fechada.status).toBe(200);

    const historico = await api("get", `/customers/${id}/orders`, { token: manager });
    expect(historico.json.data[0].total).toBe(19);
    expect(historico.json.data[0].itemCount).toBe(2); // só o item ativo
  });

  it("GET /customers/:id/summary devolve 30 dias, com o dia sem pedido zerado (e não ausente)", async () => {
    const id = await novoCliente({ name: "Grafico" });
    const comanda = await comandaFechada(id);
    await moverFechamento(comanda, iso20hLocal(-180, 5)); // 20h de São Paulo, há 5 dias

    const res = await api("get", `/customers/${id}/summary?days=30&tz=-03:00`, { token: manager });
    expect(res.status).toBe(200);

    // 30 pontos, sequência completa de `from` a `to` terminando em hoje.
    expect(res.json.series).toHaveLength(30);
    expect(res.json.series[29].day).toBe(res.json.to);
    expect(res.json.to).toBe(diaLocal(-180, 0));
    expect(res.json.from).toBe(diaLocal(-180, 29));

    // Dia SEM pedido existe na série e vem zerado: gráfico com buraco é pior
    // que gráfico nenhum (o frontend desenha exatamente os pontos que recebe).
    const ontem = res.json.series.find((p: any) => p.day === diaLocal(-180, 1));
    expect(ontem).toBeDefined();
    expect(ontem.total).toBe(0);
    expect(ontem.orderCount).toBe(0);

    // A comanda cai no dia LOCAL dela, não no dia UTC (20h de SP = 23h UTC).
    const ponto = res.json.series.find((p: any) => p.day === diaLocal(-180, 5));
    expect(ponto.total).toBe(19);
    expect(ponto.orderCount).toBe(1);

    // Totais batem com a soma dos pontos desenhados.
    expect(res.json.totals.total).toBe(19);
    expect(res.json.totals.orderCount).toBe(1);

    // Label pronto em pt-BR pelo backend — o cliente nunca formata data.
    expect(ponto.label).toMatch(/^\d{2}\/\d{2}$/);
  });

  it("summary: cliente sem consumo devolve a série toda zerada, sem erro", async () => {
    const id = await novoCliente({ name: "Nunca Consumiu" });
    const res = await api("get", `/customers/${id}/summary?days=7&tz=-03:00`, { token: manager });
    expect(res.status).toBe(200);
    expect(res.json.series).toHaveLength(7);
    expect(res.json.series.every((p: any) => p.total === 0 && p.orderCount === 0)).toBe(true);
    expect(res.json.totals).toEqual({ total: 0, orderCount: 0 });
  });

  it("summary: days é limitado e a comanda em aberto não entra no gráfico", async () => {
    const id = await novoCliente({ name: "Limites" });
    const fechada = await comandaFechada(id);
    await moverFechamento(fechada, iso20hLocal(-180, 2));
    await comandaAberta(id); // aberta: não é venda, então não vai para o gráfico

    // days=0 e days=9999 não quebram nem varram a base: o teto é 365.
    const curto = await api("get", `/customers/${id}/summary?days=0`, { token: manager });
    expect(curto.json.series).toHaveLength(1);
    const enorme = await api("get", `/customers/${id}/summary?days=9999`, { token: manager });
    expect(enorme.json.series).toHaveLength(365);

    // Default sem parâmetro = 30 dias.
    const padrao = await api("get", `/customers/${id}/summary`, { token: manager });
    expect(padrao.json.series).toHaveLength(30);
    expect(padrao.json.totals.orderCount).toBe(1); // só a fechada

    const inexistente = await api("get", "/customers/nao-existe/summary", { token: manager });
    expect(inexistente.status).toBe(404);

    const tzInvalido = await api("get", `/customers/${id}/summary?tz=brasil`, { token: manager });
    expect(tzInvalido.status).toBe(400);
  });

  it("garçom não acessa as leituras novas do detalhe (403)", async () => {
    const id = await novoCliente({ name: "So Gerencia" });
    expect((await api("get", `/customers/${id}/orders`, { token: waiter })).status).toBe(403);
    expect((await api("get", `/customers/${id}/summary`, { token: waiter })).status).toBe(403);
    expect((await api("get", `/customers/${id}`, { token: waiter })).status).toBe(403);
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
    expect(upload.json().photoPath).toBe(`/uploads/user/${criado.json.id}.png`);

    const lista = await api("get", "/users", { token: manager });
    const eu = lista.json.find((u: any) => u.id === criado.json.id);
    expect(eu.photoPath).toBe(`/uploads/user/${criado.json.id}.png`);

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
