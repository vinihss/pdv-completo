import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  seedFixture,
  resetState,
  closeTestApp,
  testApp,
  tokenOf,
  cashier,
  waiter,
  manager,
  FIXTURE,
  raw,
} from "./helpers.js";

// Perfis caixa e entregador ("implementar perfis de usuário: caixa, entregador"):
// - tela de login respeita os toggles de rollout (kitchen_enabled / uses_delivery);
// - caixa acessa o fluxo de caixa, mas não gerência/comandas;
// - entregador acessa só as próprias entregas;
// - gerente cria entregador (PIN devolvido uma vez), e o fluxo de entrega
//   assign → dispatch → deliver fecha a comanda do delivery.

const COURIER_ID = "u-courier";
const courier = tokenOf(COURIER_ID, "courier");

async function setStoreFlag(column: "uses_delivery" | "kitchen_enabled", value: boolean) {
  await raw.all(`UPDATE store_settings SET ${column} = $1 WHERE id = 'singleton'`, [value]);
}

async function loginSurface(): Promise<Array<{ id: string; name: string; role: string; photoPath: string | null }>> {
  const res = await api("get", "/auth/users");
  return res.json;
}

// Cria um pedido self-service (rota pública) com entrega já no status inicial
// "awaiting_courier" — é o jeito de nascer uma entrega no sistema.
async function createDeliveryOrder() {
  const res = await api("post", "/public/orders", {
    body: {
      correlationId: crypto.randomUUID(),
      channel: "web",
      customerPhone: "11988887777",
      customerName: "Cliente Entrega",
      newAddress: {
        street: "Rua das Flores",
        number: "123",
        neighborhood: "Centro",
        city: "Sao Paulo",
      },
      items: [{ productId: FIXTURE.product, quantity: 1 }],
      paymentMethodIntent: "card",
    },
  });
  expect(res.status).toBe(201);
  return { orderId: res.json.orderId as string, deliveryId: res.json.deliveryId as string };
}

describe("tela de login por perfil (GET /auth/users)", () => {
  beforeAll(async () => {
    await seedFixture();
    await raw.all(`INSERT INTO "user" (id, name, role, pin_hash) VALUES ($1, 'Entregador Teste', 'courier', 'x') ON CONFLICT (id) DO NOTHING`, [COURIER_ID]);
  });
  // Restaura os toggles de rollout: sem isso os arquivos seguintes herdam
  // kitchen_enabled/uses_delivery zerados (em modo sem cozinha os itens
  // nascem "delivered" — a suíte de self-service depende do modo com cozinha).
  afterAll(async () => {
    await setStoreFlag("uses_delivery", true);
    await setStoreFlag("kitchen_enabled", true);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  it("esconde entregador quando uses_delivery está desligado (e cozinha quando desligada)", async () => {
    await setStoreFlag("uses_delivery", false);
    await setStoreFlag("kitchen_enabled", false);
    const users = await loginSurface();
    const roles = users.map((u) => u.role);
    expect(roles).toContain("waiter");
    expect(roles).toContain("manager");
    expect(roles).toContain("cashier");
    expect(roles).not.toContain("courier");
    expect(roles).not.toContain("kitchen");
  });

  it("mostra entregador quando uses_delivery está ligado", async () => {
    await setStoreFlag("uses_delivery", true);
    await setStoreFlag("kitchen_enabled", false);
    const roles = (await loginSurface()).map((u) => u.role);
    expect(roles).toContain("courier");
    expect(roles).not.toContain("kitchen");
  });

  it("foto da equipe aparece na grade do login e na sessão", async () => {
    const criado = await api("post", "/users", { token: manager, body: { name: "Com Foto", role: "waiter" } });
    expect(criado.status).toBe(201);

    // Upload de verdade (não um UPDATE em photo_path): o que se quer garantido
    // é o caminho público no formato que o <img> do app consome, e a
    // nomenclatura do arquivo é o que faz o login não dar 404 na foto.
    const app = await testApp();
    const form = new FormData();
    form.append(
      "photo",
      new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" }),
      "foto.png"
    );
    const upload = await app.inject({
      method: "POST",
      url: `/users/${criado.json.id}/photo`,
      headers: { authorization: `Bearer ${manager}` },
      payload: form,
    });
    expect(upload.statusCode).toBe(200);

    const eu = (await loginSurface()).find((u) => u.id === criado.json.id);
    expect(eu?.photoPath).toBe(`/uploads/user/${criado.json.id}.png`);

    // A sessão também carrega a foto: é ela que a identidade de quem está
    // logado desenha (o menu), sem nova chamada depois do login.
    const login = await api("post", "/auth/login", { body: { userId: criado.json.id, pin: criado.json.pin } });
    expect(login.status).toBe(200);
    expect(login.json.user.photoPath).toBe(`/uploads/user/${criado.json.id}.png`);
  });

  it("quem não tem foto vem com photoPath nulo (o app cai para as iniciais)", async () => {
    const eu = (await loginSurface()).find((u) => u.id === FIXTURE.waiter);
    expect(eu?.photoPath).toBeNull();
  });
});

describe("acesso por papel — caixa (cashier)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("caixa acessa o fluxo de caixa, mas não gerência, comandas nem entregas", async () => {
    const drawer = await api("get", "/cash-drawer/current", { token: cashier });
    expect(drawer.status).toBe(200);

    const users = await api("get", "/users", { token: cashier });
    expect(users.status).toBe(403);
    expect(users.json.error.code).toBe("forbidden_role");

    const orders = await api("post", "/orders", {
      token: cashier,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expect(orders.status).toBe(403);

    const deliveries = await api("get", "/manager/deliveries", { token: cashier });
    expect(deliveries.status).toBe(403);
  });
});

describe("acesso por papel — entregador (courier)", () => {
  beforeAll(async () => {
    await seedFixture();
    await raw.all(`INSERT INTO "user" (id, name, role, pin_hash) VALUES ($1, 'Entregador Teste', 'courier', 'x') ON CONFLICT (id) DO NOTHING`, [COURIER_ID]);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("entregador acessa as próprias entregas, mas não comandas/gerência/caixa", async () => {
    const deliveries = await api("get", "/courier/deliveries", { token: courier });
    expect(deliveries.status).toBe(200);
    expect(deliveries.json).toEqual([]);

    const orders = await api("post", "/orders", {
      token: courier,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expect(orders.status).toBe(403);

    const users = await api("get", "/users", { token: courier });
    expect(users.status).toBe(403);

    const drawer = await api("get", "/cash-drawer/current", { token: courier });
    expect(drawer.status).toBe(403);
  });
});

describe("gerente cadastra entregador", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("POST /users (role courier) devolve o PIN uma vez e o entregador consegue logar", async () => {
    const created = await api("post", "/users", { token: manager, body: { name: "Entregador Novo", role: "courier" } });
    expect(created.status).toBe(201);
    expect(created.json.pin).toMatch(/^\d{4}$/);

    const login = await api("post", "/auth/login", { body: { userId: created.json.id, pin: created.json.pin } });
    expect(login.status).toBe(200);
    expect(login.json.user.role).toBe("courier");
    expect(login.json.token).toBeTruthy();

    const deliveries = await api("get", "/courier/deliveries", { token: login.json.token });
    expect(deliveries.status).toBe(200);
    expect(deliveries.json).toEqual([]);
  });
});

describe("perfil self-service (GET/PATCH/POST/DELETE /auth/me)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  // Usuário criado para o teste (não o da fixture): o endpoint mexe em
  // name/phone/email do próprio registro e nada aqui pode vazar para as
  // outras suítes. O `resetState` NÃO apaga usuários (só reativa os da
  // fixture), então este describe faz a limpeza dele — sem isso, um email
  // deixado para trás quebraria outro arquivo que partilha o mesmo banco do
  // worker (team-customers.test.ts cria `novo@exemplo.com` e o
  // `assertEmailAvailable` devolveria 400 no create).
  const criados: string[] = [];

  afterEach(async () => {
    if (!criados.length) return;
    // audit_log referencia user (NO ACTION): filho primeiro.
    await raw.all(`DELETE FROM audit_log WHERE user_id = ANY($1::text[])`, [criados]);
    await raw.all(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [criados]);
    criados.length = 0;
  });

  async function novoFuncionario() {
    const created = await api("post", "/users", {
      token: manager,
      body: { name: "Perfil Original", role: "waiter" },
    });
    expect(created.status).toBe(201);
    criados.push(created.json.id);
    return { id: created.json.id as string, token: tokenOf(created.json.id, "waiter") };
  }

  // PNG 1x1 mínimo (mesmo blob do teste de foto da equipe lá em cima).
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  // Upload multipart da própria foto — mesmo formato que o frontend monta
  // (FormData com Blob no campo "photo"), via `app.inject` como o teste de
  // foto da equipe. `form` deixa a chamada montar o corpo sozinha (caso
  // "sem arquivo"); `token` indefinido manda a requisição sem sessão.
  async function minhaFoto(
    token?: string,
    opts: { type?: string; filename?: string; form?: FormData } = {}
  ) {
    const app = await testApp();
    const form = opts.form ?? new FormData();
    if (!opts.form) {
      form.append(
        "photo",
        new Blob([Buffer.from(PNG_1PX, "base64")], { type: opts.type ?? "image/png" }),
        opts.filename ?? "foto.png"
      );
    }
    return app.inject({
      method: "POST",
      url: "/auth/me/photo",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload: form,
    });
  }

  it("garçom atualiza o próprio name/phone/email sem passar pelo PATCH manager-only", async () => {
    const { id, token } = await novoFuncionario();

    const res = await api("patch", "/auth/me", {
      token,
      body: { name: "Perfil Atualizado", phone: "(11) 91234-5678", email: "  Novo@Exemplo.COM " },
    });
    expect(res.status).toBe(200);
    // Mesmo serialize do PATCH /users/:id, com as normalizações do usecase:
    // telefone em dígitos crus e email em minúsculas (docs/agent-backend.md).
    expect(res.json).toMatchObject({
      id,
      name: "Perfil Atualizado",
      role: "waiter",
      active: true,
      phone: "11912345678",
      email: "novo@exemplo.com",
    });

    const row = await raw.get(`SELECT name, phone, email FROM "user" WHERE id = $1`, [id]);
    expect(row).toMatchObject({ name: "Perfil Atualizado", phone: "11912345678", email: "novo@exemplo.com" });

    // Audit log na mesma transação da escrita (convenção de domínio).
    const audit = await raw.get(
      `SELECT details FROM audit_log WHERE user_id = $1 AND action = 'user_profile_updated'`,
      [id],
    );
    // `audit_log.details` é text com JSON stringificado.
    expect(JSON.parse(audit.details)).toMatchObject({ userId: id });
  });

  it("campos proibidos (role, pin, active) são rejeitados pelo schema e nada muda", async () => {
    const { id, token } = await novoFuncionario();
    const before = await raw.get(`SELECT role, pin_hash, active FROM "user" WHERE id = $1`, [id]);

    const res = await api("patch", "/auth/me", {
      token,
      body: { name: "Hacker", role: "manager", pin: "9999", active: false },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");

    expect(await raw.get(`SELECT role, pin_hash, active FROM "user" WHERE id = $1`, [id])).toEqual(before);

    // E o escopo continua o de sempre: o garçom segue sem acessar gestão de equipe.
    const users = await api("get", "/users", { token });
    expect(users.status).toBe(403);
  });

  it("sem token responde 401", async () => {
    const semToken = await api("patch", "/auth/me", { body: { name: "Sem Token" } });
    expect(semToken.status).toBe(401);
    expect(semToken.json.error.code).toBe("unauthorized");

    const getSemToken = await api("get", "/auth/me");
    expect(getSemToken.status).toBe(401);
    expect(getSemToken.json.error.code).toBe("unauthorized");
  });

  it("GET /auth/me devolve o perfil fresco (phone/email que o login não traz)", async () => {
    const { id, token } = await novoFuncionario();
    await api("patch", "/auth/me", {
      token,
      body: { name: "Perfil Atualizado", phone: "11912345678", email: "fresco@exemplo.com" },
    });

    const res = await api("get", "/auth/me", { token });
    expect(res.status).toBe(200);
    // Mesmo serialize do PATCH — é daqui que a tela de perfil inicializa os
    // campos; o login devolve só { id, name, role, photoPath }.
    expect(res.json).toMatchObject({
      id,
      name: "Perfil Atualizado",
      role: "waiter",
      active: true,
      phone: "11912345678",
      email: "fresco@exemplo.com",
    });
  });

  it("GET /auth/me responde 404 quando o usuário do token não existe mais", async () => {
    const { id, token } = await novoFuncionario();
    // Primeira leitura aquece o cache de ~30s do assertUserActive (docs/21
    // §5.4): sem ele o middleware responderia 401 antes do usecase e o 404
    // não teria como acontecer — mesma janela do PATCH.
    expect((await api("get", "/auth/me", { token })).status).toBe(200);

    await raw.all(`DELETE FROM "user" WHERE id = $1`, [id]);

    const res = await api("get", "/auth/me", { token });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("not_found");
  });

  it("name vazio e email inválido são recusados", async () => {
    const { token } = await novoFuncionario();

    const vazio = await api("patch", "/auth/me", { token, body: { name: "" } });
    expect(vazio.status).toBe(400);
    expect(vazio.json.error.code).toBe("validation_failed");

    const emailRuim = await api("patch", "/auth/me", { token, body: { name: "Ok", email: "nao-e-email" } });
    expect(emailRuim.status).toBe(400);
    expect(emailRuim.json.error.code).toBe("validation_failed");
  });

  it("email já usado por outra pessoa é recusado (mesma régua do update de gerente)", async () => {
    const primeiro = await novoFuncionario();
    const res = await api("patch", "/auth/me", {
      token: primeiro.token,
      body: { name: "Ok", email: "dono@exemplo.com" },
    });
    expect(res.status).toBe(200);

    const outro = await novoFuncionario();
    const colisao = await api("patch", "/auth/me", {
      token: outro.token,
      body: { name: "Ok", email: "dono@exemplo.com" },
    });
    expect(colisao.status).toBe(400);
    expect(colisao.json.error.code).toBe("validation_failed");
  });

  // ---------- Foto do próprio perfil (POST/DELETE /auth/me/photo) ----------
  // O upload/remoção de foto da equipe é manager-only (`/users/:id/photo`);
  // estes dois endpoints existem para a tela de perfil self-service não
  // depender de gerente — mesmo usecase, mesmo serialize, id do token.

  it("garçom envia a própria foto e o perfil volta com photoPath", async () => {
    const { id, token } = await novoFuncionario();

    const upload = await minhaFoto(token);
    expect(upload.statusCode).toBe(200);
    // Mesmo serialize do PATCH/GET /auth/me (inclui photoPath) — a resposta
    // que a tela de perfil consome, sem segunda chamada.
    expect(upload.json()).toMatchObject({
      id,
      role: "waiter",
      active: true,
      photoPath: `/uploads/user/${id}.png`,
    });

    // O arquivo nasce com o nome GERADO pelo backend (id + ext), não o que o
    // cliente enviou, e aparece na leitura fresca do perfil.
    const perfil = await api("get", "/auth/me", { token });
    expect(perfil.status).toBe(200);
    expect(perfil.json.photoPath).toBe(`/uploads/user/${id}.png`);
    const row = await raw.get(`SELECT photo_path FROM "user" WHERE id = $1`, [id]);
    expect(row.photo_path).toBe(`${id}.png`);

    // Audit log na mesma transação da escrita (convenção de domínio).
    const audit = await raw.get(
      `SELECT details FROM audit_log WHERE user_id = $1 AND action = 'user_photo_changed'`,
      [id]
    );
    expect(JSON.parse(audit.details)).toMatchObject({ userId: id });

    // Limpeza: remove o arquivo do disco (o `afterEach` apaga só a linha do
    // banco — o arquivo `<id>.png` ficaria órfão no diretório de uploads).
    expect((await api("delete", "/auth/me/photo", { token })).status).toBe(200);
  });

  it("MIME fora de jpeg/png/webp é recusado com validation_failed (field photo) e nada muda", async () => {
    const { id, token } = await novoFuncionario();

    const res = await minhaFoto(token, { type: "application/pdf", filename: "foto.pdf" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "validation_failed",
      details: { field: "photo" },
    });

    expect((await api("get", "/auth/me", { token })).json.photoPath).toBeNull();
    expect(await raw.get(`SELECT photo_path FROM "user" WHERE id = $1`, [id])).toMatchObject({
      photo_path: null,
    });
  });

  it("sem arquivo no multipart (ou sem multipart nenhum) é validation_failed em photo", async () => {
    const { token } = await novoFuncionario();

    // Corpo multipart válido, mas sem a parte de arquivo: `req.file()` não
    // devolve nada → mesmo erro da rota manager.
    const form = new FormData();
    form.append("legenda", "só texto");
    const semArquivo = await minhaFoto(token, { form });
    expect(semArquivo.statusCode).toBe(400);
    expect(semArquivo.json().error).toMatchObject({
      code: "validation_failed",
      details: { field: "photo" },
    });

    // Sem multipart nenhum: antes do guard respondia o erro cru do plugin
    // (500 fora do catálogo); hoje é o mesmo 400.
    const semMultipart = await api("post", "/auth/me/photo", { token });
    expect(semMultipart.status).toBe(400);
    expect(semMultipart.json.error).toMatchObject({
      code: "validation_failed",
      details: { field: "photo" },
    });
  });

  it("DELETE /auth/me/photo remove a própria foto e devolve photoPath null", async () => {
    const { id, token } = await novoFuncionario();
    expect((await minhaFoto(token)).statusCode).toBe(200);

    const res = await api("delete", "/auth/me/photo", { token });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id, photoPath: null });

    expect(await raw.get(`SELECT photo_path FROM "user" WHERE id = $1`, [id])).toMatchObject({
      photo_path: null,
    });
    expect((await api("get", "/auth/me", { token })).json.photoPath).toBeNull();

    const audit = await raw.get(
      `SELECT details FROM audit_log WHERE user_id = $1 AND action = 'user_photo_removed'`,
      [id]
    );
    expect(JSON.parse(audit.details)).toMatchObject({ userId: id });
  });

  it("sem token responde 401 nos dois endpoints de foto", async () => {
    const upload = await minhaFoto(undefined);
    expect(upload.statusCode).toBe(401);
    expect(upload.json().error.code).toBe("unauthorized");

    const remocao = await api("delete", "/auth/me/photo");
    expect(remocao.status).toBe(401);
    expect(remocao.json.error.code).toBe("unauthorized");
  });

  it("foto do próprio perfil responde 404 quando o usuário do token não existe mais", async () => {
    const { id, token } = await novoFuncionario();
    // Mesma janela do GET/PATCH: a primeira leitura aquece o cache de ~30s do
    // assertUserActive (docs/21 §5.4) — sem isso o middleware responderia 401
    // antes dos usecases e o 404 não teria como acontecer.
    expect((await api("get", "/auth/me", { token })).status).toBe(200);

    await raw.all(`DELETE FROM "user" WHERE id = $1`, [id]);

    // Upload: o usecase recusa ANTES de gravar arquivo — nenhum órfão em disco.
    const upload = await minhaFoto(token);
    expect(upload.statusCode).toBe(404);
    expect(upload.json().error.code).toBe("not_found");

    const remocao = await api("delete", "/auth/me/photo", { token });
    expect(remocao.status).toBe(404);
    expect(remocao.json.error.code).toBe("not_found");
  });
});

describe("fluxo completo de entrega — assign → dispatch → deliver", () => {
  beforeAll(async () => {
    await seedFixture();
    await raw.all(`INSERT INTO "user" (id, name, role, pin_hash) VALUES ($1, 'Entregador Teste', 'courier', 'x') ON CONFLICT (id) DO NOTHING`, [COURIER_ID]);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("manager atribui, entregador confirma saída, entrega e a comanda fecha", async () => {
    await setStoreFlag("uses_delivery", true);

    const { orderId, deliveryId } = await createDeliveryOrder();

    const managerList = await api("get", "/manager/deliveries", { token: manager });
    expect(managerList.status).toBe(200);
    const pending = managerList.json.find((d: any) => d.id === deliveryId);
    expect(pending.status).toBe("awaiting_courier");
    expect(pending.courier).toBeNull();
    // A tela de entregas mostra "quem pediu" e "quando caiu" no mesmo card.
    expect(pending.customerName).toBe("Cliente Entrega");
    expect(pending.createdAt).toBeTruthy();
    expect(pending.deliveredAt).toBeNull();

    const assign = await api("patch", `/manager/deliveries/${deliveryId}/assign`, {
      token: manager,
      body: { courierId: COURIER_ID },
    });
    expect(assign.status).toBe(200);
    expect(assign.json.courierId).toBe(COURIER_ID);

    const myList = await api("get", "/courier/deliveries", { token: courier });
    expect(myList.status).toBe(200);
    expect(myList.json).toHaveLength(1);
    expect(myList.json[0]).toMatchObject({ id: deliveryId, status: "awaiting_courier" });

    const dispatch = await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courier });
    expect(dispatch.status).toBe(200);
    expect(dispatch.json.status).toBe("out_for_delivery");

    const deliver = await api("patch", `/courier/deliveries/${deliveryId}/deliver`, { token: courier });
    expect(deliver.status).toBe(200);
    expect(deliver.json.status).toBe("delivered");

    const afterDeliver = await api("get", "/manager/deliveries", { token: manager });
    const settled = afterDeliver.json.find((d: any) => d.id === deliveryId);
    expect(settled.status).toBe("delivered");
    expect(settled.deliveredAt).toBeTruthy();

    const order = await api("get", `/orders/${orderId}`, { token: waiter });
    expect(order.status).toBe(200);
    expect(order.json.status).toBe("closed");
    // A comanda carrega o endereço — é o que a tela da comanda mostra.
    expect(order.json.delivery).toMatchObject({
      status: "delivered",
      address: "Rua das Flores, 123 - Centro, Sao Paulo",
    });
  });

  it("lista e detalhe devolvem a mesma entrega (o endereço aparece já no primeiro toque)", async () => {
    await setStoreFlag("uses_delivery", true);

    const { orderId } = await createDeliveryOrder();

    const list = await api("get", "/orders?status=open", { token: waiter });
    expect(list.status).toBe(200);
    const listed = list.json.data.find((o: any) => o.id === orderId);
    expect(listed.delivery).toMatchObject({
      status: "awaiting_courier",
      address: "Rua das Flores, 123 - Centro, Sao Paulo",
    });

    // Regressão do print: o mapper do daemon já lia customerPhone/delivery e a
    // API não mandava nada dos dois.
    expect(listed.customerPhone).toBe("11988887777");
  });

  it("entregador não mexe numa entrega que não é dele", async () => {
    await setStoreFlag("uses_delivery", true);

    const { deliveryId } = await createDeliveryOrder();

    // Nenhuma atribuição — dispatch de outra pessoa é proibido (forbidden_role).
    const dispatch = await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courier });
    expect(dispatch.status).toBe(403);
    expect(dispatch.json.error.code).toBe("forbidden_role");
  });
});