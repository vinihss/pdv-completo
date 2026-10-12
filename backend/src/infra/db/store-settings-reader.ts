import { eq } from "drizzle-orm";
import { db, type Db } from "./client.js";
import { storeSettings } from "./schema.js";
import type { StoreSettingsRecord, StoreSettingsReader } from "../../application/ports/effects.js";

/**
 * Adapter do port `StoreSettingsReader` (ports/effects.ts) — ONDA 2.
 *
 * Espelha `getSettings()` de `order.usecases`: singleton `id = 'singleton'`,
 * e a MESMA mensagem de erro quando a linha não existe (o 500 do boot sem
 * seed continua idêntico). A leitura é do proxy `db` por default (escopo ALS
 * corrente — igual a hoje); um tenant explícito pode ser injetado via
 * construtor (`tenantDb(tenant.schemaName)`).
 *
 * O record devolvido é a LINHA INTEIRA de `store_settings` (40+ colunas):
 * estruturalmente cobre `StoreSettingsRecord`, que é o contrato mínimo que o
 * port declara — quem enxerga o port só pode usar os 10 campos documentados.
 */
export class PostgresStoreSettingsReader implements StoreSettingsReader {
  constructor(private readonly database: Db = db) {}

  async get(): Promise<StoreSettingsRecord> {
    const s = await this.database.query.storeSettings.findFirst({
      where: eq(storeSettings.id, "singleton"),
    });
    if (!s) throw new Error("store_settings não inicializado — rode o seed.");
    return s;
  }
}
