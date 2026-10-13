import type {
  PublicTenantBrand,
  PublicTenantBrandReader,
} from "../../application/ports/effects.js";
import { Errors } from "../../domain/errors.js";
import { pool } from "./client.js";
import { PostgresStoreSettingsReader } from "./store-settings-reader.js";
import { runInTenantScope } from "./tenant-context.js";

/**
 * Adapter do port `PublicTenantBrandReader` (ports/effects.ts).
 *
 * Encapsula a leitura da marca PÚBLICA da loja (a vitrine de pedidos): entra no
 * escopo do tenant (ALS + pool por schema), confere que o schema está
 * provisionado e lê o `store_settings` DELE. O use case de tenant
 * (`application/tenant/resolve-tenant.usecase.ts`) recebe só o resultado — a
 * `application` nunca importa ALS, pool nem informação de schema.
 *
 * A checagem de provisionamento é EXPLÍCITA (`information_schema.tables`), e
 * não "tenta ler e captura": o `search_path` do pool cai para `public` em
 * SILÊNCIO quando o schema do tenant não existe, e a vitrine serviria a marca
 * da plataforma achando que é da loja (`docs/15` §6). A query é qualificada por
 * `table_schema`, então responde pela existência real do schema.
 */
export class PublicTenantBrandReaderAdapter implements PublicTenantBrandReader {
  async read(tenant: {
    slug: string;
    schemaName: string;
    isDefault: boolean;
  }): Promise<PublicTenantBrand> {
    return runInTenantScope(
      { schemaName: tenant.schemaName, slug: tenant.slug, isDefault: tenant.isDefault },
      async () => {
        const { rows } = await pool.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'store_settings' LIMIT 1`,
          [tenant.schemaName],
        );
        if (rows.length === 0) {
          console.error(
            `[tenant] ${tenant.slug} resolve para o schema ${tenant.schemaName}, que não está provisionado ` +
              `(sem store_settings) — vitrine indisponível até o provisionamento`,
          );
          throw Errors.tenantSchemaUnavailable(tenant.slug, tenant.schemaName);
        }

        const s = await new PostgresStoreSettingsReader().get();
        return {
          name: s.merchantName,
          logoUrl: s.logoPath ? `/uploads/logo/${s.logoPath}` : null,
          primaryColor: s.brandColor,
          usesDelivery: s.usesDelivery,
          kitchenEnabled: s.kitchenEnabled,
        };
      },
    );
  }
}
