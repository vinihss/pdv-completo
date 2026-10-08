import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, closeTestApp, FIXTURE, manager, raw, resetState, seedFixture, testApp } from "./helpers.js";

const run = promisify(execFile);

// PNG 1×1 de verdade (o mesmo dos outros testes): o corpo servido tem que bater
// byte a byte com o que o upload gravou.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function app() {
  return testApp();
}

// inject multipart: o light-my-request só monta o body quando o payload é um
// FormData (o helper `api` só cobre JSON) — mesmo truque de
// team-customers.test.ts.
async function upload(
  url: string,
  field = "photo",
  filename = "foto.png",
  mimetype = "image/png",
  body = PNG
) {
  const form = new FormData();
  form.append(field, new Blob([body], { type: mimetype }), filename);
  const instance = await app();
  return instance.inject({ method: "POST", url, headers: { authorization: `Bearer ${manager}` }, payload: form });
}

async function fetchAsset(url: string, headers: Record<string, string> = {}) {
  const instance = await app();
  return instance.inject({ method: "GET", url, headers });
}

describe("storage: porta + serving de /uploads", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("upload de foto de cliente é servido pela URL que a API devolve", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Foto Servida" } });
    const id = criado.json.id;

    const uploadRes = await upload(`/customers/${id}/photo`);
    expect(uploadRes.statusCode).toBe(200);
    // Um segmento a mais: o layout em disco é <schema>/<kind>/<arquivo>.
    expect(uploadRes.json().photoPath).toBe(`/uploads/customer/${id}.png`);

    const res = await fetchAsset(`/uploads/customer/${id}.png`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("logo é servido com no-cache (é sobrescrito no lugar, mesmo nome)", async () => {
    const uploadRes = await upload("/store-settings/logo", "logo", "logo.png");
    expect(uploadRes.statusCode).toBe(200);

    const logoUrl = (await api("get", "/store-settings", { token: manager })).json.logoUrl;
    expect(logoUrl).toBe("/uploads/logo/logo.png");

    const res = await fetchAsset(logoUrl);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("ETag responde 304 quando o cliente já tem a versão", async () => {
    const uploadRes = await upload("/store-settings/logo", "logo", "logo.png");
    expect(uploadRes.statusCode).toBe(200);

    const first = await fetchAsset("/uploads/logo/logo.png");
    const etag = first.headers["etag"];
    expect(etag).toBeTruthy();
    expect(first.headers["last-modified"]).toBeTruthy();

    const revalidated = await fetchAsset("/uploads/logo/logo.png", { "if-none-match": etag });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe("");
  });

  it("a coluna guarda só o basename — nenhuma migration, nenhum outro formato", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Só Basename" } });
    expect((await upload(`/customers/${criado.json.id}/photo`)).statusCode).toBe(200);

    const row = await raw.get("SELECT photo_path FROM customer WHERE id = $1", [criado.json.id]);
    expect(row.photo_path).toBe(`${criado.json.id}.png`);
  });

  // ---- o serving não pode deixar sair nada do volume ----

  it.each([
    ["traversal com %2F", "/uploads/product/..%2F..%2Fetc%2Fpasswd"],
    ["traversal cru", "/uploads/product/../../etc/passwd"],
    ["dot-dot isolado", "/uploads/product/.."],
    ["caminho absoluto", "/uploads/product/%2Fetc%2Fpasswd"],
    ["dotfile", "/uploads/product/.env"],
    ["kind fora da whitelist", "/uploads/segredo/logo.png"],
    ["traversal no kind", "/uploads/..%2F..%2Fetc/logo.png"],
    ["kind que é o schema", "/uploads/public/logo.png"],
    ["extensão não servível", "/uploads/product/guia.svg"],
    ["nome com espaço", "/uploads/product/meu arquivo.png"],
    ["nome vazio", "/uploads/product/"],
  ])("serving devolve 404: %s", async (_label, url) => {
    expect((await fetchAsset(url)).statusCode).toBe(404);
  });

  it("arquivo existente só é servido no kind dele (foto de cliente não vira logo)", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Kind Errado" } });
    const id = criado.json.id;
    expect((await upload(`/customers/${id}/photo`)).statusCode).toBe(200);

    expect((await fetchAsset(`/uploads/logo/${id}.png`)).statusCode).toBe(404);
  });

  it("remover a foto tira o arquivo do ar", async () => {
    const criado = await api("post", "/customers", { token: manager, body: { name: "Some Depois" } });
    const id = criado.json.id;
    expect((await upload(`/customers/${id}/photo`)).statusCode).toBe(200);
    expect((await fetchAsset(`/uploads/customer/${id}.png`)).statusCode).toBe(200);

    expect((await api("delete", `/customers/${id}/photo`, { token: manager })).status).toBe(200);

    expect((await fetchAsset(`/uploads/customer/${id}.png`)).statusCode).toBe(404);
  });
});

// ---- o defeito do logo: nome fixo (`logo.<ext>`) num diretório único ----
//
// O multi-tenant ainda não está implementado (docs/15 §6 — nada de Host, ALS
// ou `search_path` aqui), então o teste é no nível do storage: dois schemas
// com o MESMO kind e o MESMO nome de arquivo convivem, cada um com seu
// conteúdo. É a propriedade que fecha o `logo.<ext>` sobrescrevendo o da outra
// loja (§5.2) e a leitura cruzada de `/uploads/*` sem fronteira (§5.3).
describe("storage: dois tenants convivem sem colidir", () => {
  let root: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-uploads-"));
    previousEnv = process.env.DEFAULT_TENANT_SCHEMA;
    delete process.env.DEFAULT_TENANT_SCHEMA;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DEFAULT_TENANT_SCHEMA;
    else process.env.DEFAULT_TENANT_SCHEMA = previousEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // `createStorage` tira o snapshot de `config.uploadsDir` no load, então a raiz
  // do tmpdir é passada explicitamente; o schema é fixado por instância porque
  // o default é a seam, que lê o tenant *ambiente* a cada operação.
  async function storageFor(schema: string) {
    const { createStorage } = await import("../src/infra/storage/index.js");
    return createStorage(root, () => schema);
  }

  it("logo de uma loja não sobrescreve o da outra", async () => {
    const lojaA = await storageFor("tenant_a");
    const lojaB = await storageFor("tenant_b");

    await lojaA.put("logo", "logo.png", Buffer.from("logo-da-loja-a"));
    await lojaB.put("logo", "logo.png", Buffer.from("logo-da-loja-b"));

    // Mesmo nome, mesma extensão, diretórios diferentes — o que o layout flat
    // não conseguia fazer.
    expect(fs.readFileSync(path.join(root, "tenant_a", "logo", "logo.png"), "utf8")).toBe("logo-da-loja-a");
    expect(fs.readFileSync(path.join(root, "tenant_b", "logo", "logo.png"), "utf8")).toBe("logo-da-loja-b");

    const lidoA = await lojaA.get("logo", "logo.png");
    const lidoB = await lojaB.get("logo", "logo.png");
    expect(lidoA?.body.toString("utf8")).toBe("logo-da-loja-a");
    expect(lidoB?.body.toString("utf8")).toBe("logo-da-loja-b");
  });

  it("remover o arquivo de uma loja não toca no da outra", async () => {
    const lojaA = await storageFor("tenant_a");
    const lojaB = await storageFor("tenant_b");
    await lojaA.put("logo", "logo.png", Buffer.from("a"));
    await lojaB.put("logo", "logo.png", Buffer.from("b"));

    expect(await lojaA.remove("logo", "logo.png")).toBe(true);
    expect(await lojaA.get("logo", "logo.png")).toBeNull();
    expect(await lojaB.get("logo", "logo.png")).not.toBeNull();

    // Remover de novo não é erro (órfão não impede nada) — é o comportamento que
    // os use cases herdaram.
    expect(await lojaA.remove("logo", "logo.png")).toBe(false);
  });

  it("o schema vem da seam: DEFAULT_TENANT_SCHEMA hoje, ALS na Fase 2", async () => {
    const { createStorage, resolveTenantSchema } = await import("../src/infra/storage/index.js");
    expect(resolveTenantSchema()).toBe("public");

    // Sem injetar o schema, a instância segue o tenant AMBIENTE — a propriedade
    // que faz a Fase 2 não precisar tocar em mais nenhum arquivo.
    process.env.DEFAULT_TENANT_SCHEMA = "tenant_x";
    const storageAmbiente = createStorage(root);
    expect(resolveTenantSchema()).toBe("tenant_x");

    await storageAmbiente.put("logo", "logo.png", Buffer.from("x"));
    expect(fs.existsSync(path.join(root, "tenant_x", "logo", "logo.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "public", "logo", "logo.png"))).toBe(false);
  });

  it("nome de arquivo com traversal nunca sai da raiz", async () => {
    const loja = await storageFor("tenant_a");
    await expect(loja.put("logo", "../escapou.png", Buffer.from("x"))).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(loja.get("logo", "../../etc/passwd")).rejects.toMatchObject({ code: "validation_failed" });
    expect(fs.existsSync(path.join(root, "escapou.png"))).toBe(false);
  });
});

// ---- script one-shot da migração do layout ----
describe("scripts/migrate-uploads-layout", () => {
  let root: string;
  let files: { produto: string; logo: string; cliente: string; equipe: string; orfao: string };

  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());

  beforeEach(async () => {
    resetState();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-uploads-mig-"));

    // Nomes de arquivo como o upload faria: `<id>.<ext>`, e o logo com nome fixo.
    const produto = await api("post", "/products", {
      token: manager,
      body: { name: "Mig Product", price: 1, categoryId: FIXTURE.category },
    });
    const cliente = await api("post", "/customers", { token: manager, body: { name: "Mig Customer" } });
    const usuario = await api("post", "/users", { token: manager, body: { name: "Mig User", role: "waiter" } });
    files = {
      produto: `${produto.json.id}.jpg`,
      cliente: `${cliente.json.id}.png`,
      equipe: `${usuario.json.id}.png`,
      logo: "logo.png",
      orfao: "ninguem-aponta-para-esta.png",
    };

    for (const name of Object.values(files)) fs.writeFileSync(path.join(root, name), `bytes-de-${name}`);

    await raw.exec(`UPDATE product SET image_path = '${files.produto}' WHERE id = '${produto.json.id}'`);
    await raw.exec(`UPDATE customer SET photo_path = '${files.cliente}' WHERE id = '${cliente.json.id}'`);
    await raw.exec(`UPDATE "user" SET photo_path = '${files.equipe}' WHERE id = '${usuario.json.id}'`);
    await raw.exec(`UPDATE store_settings SET logo_path = '${files.logo}' WHERE id = 'singleton'`);
  });

  afterEach(async () => {
    // `resetState` não limpa `store_settings` — o `logo_path` fica, senão a
    // suíte seguinte vê um logo apontando para arquivo que não existe.
    await raw.exec(`UPDATE store_settings SET logo_path = NULL WHERE id = 'singleton'`);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function migrate(...extra: string[]): Promise<string> {
    const { stdout } = await run(
      path.join("node_modules", ".bin", "tsx"),
      ["scripts/migrate-uploads-layout.ts", ...extra],
      { cwd: process.cwd(), env: { ...process.env, UPLOADS_DIR: root, DEFAULT_TENANT_SCHEMA: "public" } }
    );
    return stdout;
  }

  const noNovoLayout = (kind: string, name: string) => path.join(root, "public", kind, name);

  it("classifica pelo banco e move cada arquivo para o kind certo", async () => {
    const saida = await migrate();
    expect(saida).toContain("modo=move");

    for (const [kind, name] of [
      ["product", files.produto],
      ["logo", files.logo],
      ["customer", files.cliente],
      ["user", files.equipe],
    ] as const) {
      expect(fs.existsSync(noNovoLayout(kind, name)), `${kind}/${name}`).toBe(true);
      expect(fs.readFileSync(noNovoLayout(kind, name), "utf8")).toBe(`bytes-de-${name}`);
    }

    // Órfão fica onde está: o script não apaga o que não reconheceu.
    expect(fs.readFileSync(path.join(root, files.orfao), "utf8")).toBe(`bytes-de-${files.orfao}`);
    expect(saida).toContain(files.orfao);

    // E o banco continua com o basename — nenhuma migration, nenhum UPDATE.
    const colunas = await raw.get(`SELECT image_path FROM product WHERE image_path = '${files.produto}'`);
    expect(colunas.image_path).toBe(files.produto);
  });

  it("rodar 2× não faz mal (idempotente)", async () => {
    await migrate();
    const segunda = await migrate();
    expect(segunda).toContain("product: 0");
    expect(segunda).toContain("logo: 0");
    expect(segunda).toContain("customer: 0");
    expect(segunda).toContain("user: 0");
    expect(fs.existsSync(noNovoLayout("logo", files.logo))).toBe(true);
    expect(fs.readFileSync(noNovoLayout("logo", files.logo), "utf8")).toBe(`bytes-de-${files.logo}`);
  });

  it("--dry-run mostra o plano sem mover nada", async () => {
    const saida = await migrate("--dry-run");
    expect(saida).toContain("modo=dry-run");
    expect(saida).toContain("dry-run: nada foi movido");
    expect(fs.existsSync(path.join(root, files.logo))).toBe(true);
    expect(fs.existsSync(noNovoLayout("logo", files.logo))).toBe(false);
  });

  it("--revert devolve os arquivos pro layout flat", async () => {
    await migrate();
    await migrate("--revert");
    for (const name of [files.produto, files.logo, files.cliente, files.equipe]) {
      expect(fs.existsSync(path.join(root, name)), name).toBe(true);
      expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(`bytes-de-${name}`);
    }
    // Idempotente no sentido inverso também.
    await expect(migrate("--revert")).resolves.toContain("logo: 0");
  });
});
