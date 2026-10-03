import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, raw } from "./helpers.js";

// store_settings deixou de ser singleton (migration 0011_store_settings_per_store):
// agora é UMA LINHA POR STORE, com `UNIQUE (store_id)`, e cada leitura de
// configuração recebe o storeId de cima (rota → `req.storeId`, resolvido pelo
// tenant middleware). Esta suíte prova as três partes:
//
//   1. a migration cria settings para toda store que nascer sem elas;
//   2. o banco (não a aplicação) impede duas linhas para a mesma store;
//   3. as rotas leem as settings DA LOJA do request, não "a primeira linha".
//
// A store default continua com `id = 'singleton'` (dado legado e os
// `UPDATE ... WHERE id = 'singleton'` das outras suítes dependem disso); as
// demais nascem com `id = store_id`.

/** Store criada por esta suíte — id fora da faixa das stores reais. */
const OUTRA_STORE = "00000000-0000-0000-0000-000000000099";
/** Store de produção criada pela migration 0010 (slug ana-terra). */
const STORE_ANA_TERRA = "00000000-0000-0000-0000-000000000002";

const nasOutraLoja = { headers: { "x-store-id": OUTRA_STORE } };

async function criaOutraStore() {
  await raw.all(
    `INSERT INTO stores (id, name, slug, status) VALUES ($1, 'Outra Loja', 'outra-loja', 'active') ON CONFLICT (id) DO NOTHING`,
    [OUTRA_STORE]
  );
  await raw.all(
    `INSERT INTO store_settings (id, store_id, merchant_name, merchant_city, kitchen_enabled)
     VALUES ($1, $1, 'Outra Loja Nome', 'Curitiba', false)
     ON CONFLICT (id) DO NOTHING`,
    [OUTRA_STORE]
  );
}

describe("store_settings por store (0011)", () => {
  beforeAll(async () => {
    await seedFixture();
    await criaOutraStore();
    // Flags de partida da store default — as outras suítes mexem nestes
    // toggles e o `resetState()` não os restaura.
    await raw.all(`UPDATE store_settings SET kitchen_enabled = true WHERE id = 'singleton'`);
  });

  afterAll(async () => {
    await raw.all(`DELETE FROM store_settings WHERE store_id = $1`, [OUTRA_STORE]);
    await raw.all(`DELETE FROM stores WHERE id = $1`, [OUTRA_STORE]);
    // Coordenadas usadas no último teste não podem vazar para as suítes que
    // rodam depois (delivery-location cuida das dela no próprio beforeAll).
    await raw.all(`UPDATE store_settings SET restaurant_lat = NULL, restaurant_long = NULL WHERE id = 'singleton'`);
    await closeTestApp();
  });

  beforeEach(() => resetState());

  it("toda store que nasce sem settings ganha a própria linha (ana-terra, 0010 + 0011)", async () => {
    const row = await raw.get(`SELECT id, merchant_name FROM store_settings WHERE store_id = $1`, [STORE_ANA_TERRA]);
    expect(row).toBeTruthy();
    // Store que não é a default nasce com id = store_id.
    expect(row.id).toBe(STORE_ANA_TERRA);
    expect(row.merchant_name.length).toBeGreaterThan(0);
  });

  it("a store default mantém o id histórico 'singleton'", async () => {
    const row = await raw.get(`SELECT id FROM store_settings WHERE store_id = $1`, [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(row.id).toBe("singleton");
  });

  it("o banco recusa a segunda linha da mesma store (uq_store_settings_store)", async () => {
    await expect(
      raw.all(
        `INSERT INTO store_settings (id, store_id, merchant_name, merchant_city)
         VALUES ('duplicada', '00000000-0000-0000-0000-000000000001', 'Duplicada', '')`
      )
    ).rejects.toThrow(/uq_store_settings_store|duplicate key/);
  });

  it("GET /store-settings devolve as settings da loja do header, não as da default", async () => {
    const daOutra = await api("get", "/store-settings", { token: manager, ...nasOutraLoja });
    expect(daOutra.status).toBe(200);
    expect(daOutra.json.merchantName).toBe("Outra Loja Nome");

    const daDefault = await api("get", "/store-settings", { token: manager });
    expect(daDefault.status).toBe(200);
    expect(daDefault.json.merchantName).toBe("Teste Café");
  });

  it("GET /auth/users aplica os toggles da loja do request", async () => {
    // Na outra loja kitchen_enabled = false → some o usuário de cozinha.
    const naOutra = await api("get", "/auth/users", nasOutraLoja);
    expect(naOutra.status).toBe(200);
    expect(naOutra.json.some((u: { role: string }) => u.role === "kitchen")).toBe(false);

    // Na default o modo cozinha está ligado → a estação aparece.
    const naDefault = await api("get", "/auth/users");
    expect(naDefault.json.some((u: { role: string }) => u.role === "kitchen")).toBe(true);
  });

  it("POST /calcular-entrega usa as coordenadas da loja do request", async () => {
    // Coordenadas só na loja default: a outra loja não tem geocoding feito e
    // precisa responder "sem coordenadas" em vez de pegar as da default.
    await raw.all(
      `UPDATE store_settings SET restaurant_lat = -29.76, restaurant_long = -51.14 WHERE id = 'singleton'`
    );
    await raw.all(`UPDATE store_settings SET restaurant_lat = NULL, restaurant_long = NULL WHERE store_id = $1`, [
      OUTRA_STORE,
    ]);

    const naOutra = await api("post", "/calcular-entrega", {
      body: { latitude: -29.75, longitude: -51.14 },
      ...nasOutraLoja,
    });
    expect(naOutra.status).toBe(400);
    expect(naOutra.json.error.code).toBe("validation_failed");
  });
});
