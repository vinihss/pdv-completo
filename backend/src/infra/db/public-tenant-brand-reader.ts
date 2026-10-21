import type {
  PublicTenantBrand,
  PublicTenantBrandReader,
} from "../../application/ports/effects.js";
import { Errors } from "../../domain/errors.js";
import { pool } from "./client.js";
import { PostgresStoreSettingsReader } from "./store-settings-reader.js";
import { resolveTenantSchemaInScope, runInTenantScope } from "./tenant-context.js";

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
    tenantId: string;
    isDefault: boolean;
  }): Promise<PublicTenantBrand> {
    return runInTenantScope(
      {
        tenantId: tenant.tenantId,
        slug: tenant.slug,
        isDefault: tenant.isDefault,
      },
      async () => {
        // No modelo por LINHA a marca de cada loja é a LINHA dela em
        // `store_settings` — o `id` é o mesmo ('singleton') em toda loja e o
        // que as separa é a coluna `tenant_id`, filtrada pela policy de RLS.
        // Sem a linha, a loja não foi semeada: a vitrine responde 503 em vez
        // de servir a marca de outra loja.
        const { rows } = await pool.query(
          `SELECT 1 FROM store_settings WHERE id = 'singleton' LIMIT 1`,
        );
        if (rows.length === 0) {
          console.error(
            `[tenant] ${tenant.slug} não tem store_settings (loja não semeada) ` +
              `— vitrine indisponível até o seed`,
          );
          throw Errors.tenantSchemaUnavailable(tenant.slug, resolveTenantSchemaInScope());
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
