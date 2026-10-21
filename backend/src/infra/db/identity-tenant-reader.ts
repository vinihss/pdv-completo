/**
 * Adapter do port `IdentityTenantReader` (application/identity/ports).
 *
 * Encapsula o que a application não pode saber: o LOOP pelos schemas de tenant,
 * o ALS (`runInTenantScope`), o pool por schema, a checagem explícita de
 * provisionamento e o registry.
 *
 * Decisão de implementação (desvio CONSCIENTE do §4, que fala apenas em "cada
 * tenant ativo do registry"): a lista de empresas inclui também o tenant DEFAULT
 * (`DEFAULT_TENANT_SLUG`), que NÃO tem linha no registry. Sem isso, toda
 * instalação de loja única — o estado atual de produção, onde o registry está
 * vazio e o roteamento multi-tenant desligado — devolveria `companies: []` e a
 * tela mostraria "Nenhuma empresa vinculada a esta conta" para todo mundo.
 * Documentado no relatório da entrega.
 *
 * Todo `null` de `findLinkedUser` vira `403 tenant_not_linked` no use case: slug
 * desconhecido, empresa suspensa, schema não provisionado, roteamento desligado
 * para slug não-default e conta sem `user` ativo. O motivo NÃO é distinguido de
 * propósito (não revelar existência/estado de tenants, §4).
 */
import type { PublicTenantBrandReader, TenantRegistry } from "../../application/ports/effects.js";
import type { UserRole } from "../../application/ports/repositories/shared.js";
import type {
  CompanySummary,
  IdentityTenantReader,
  LinkedUserRecord,
} from "../../application/identity/ports/identity-tenant-reader.js";
import { AppError } from "../../domain/errors.js";
import { isSafeSchemaName } from "../../domain/tenant.js";
import { pool } from "./client.js";
import { runInTenantScope, type TenantScope } from "./tenant-context.js";

/** Linha do registry que este adapter consome (subconjunto do record do port). */
export interface ActiveTenantRow {
  /** Id do tenant (uuid) — a identidade estável que o escopo ALS carrega. */
  id: string;
  slug: string;
  schemaName: string;
  status: string;
}

export interface IdentityTenantReaderDeps {
  /** Marca pública da loja (nome, logo, cor) — já valida provisionamento. */
  brand: PublicTenantBrandReader;
  /** Registry por slug (cache de 60s do adapter de tenant). */
  registry: TenantRegistry;
  /**
   * Descriptor do tenant default (apex/instalação de loja única). Injetado pelo
   * composition root: a application é quem decide o que é "default"
   * (`resolveTenant`), a infra só usa.
   */
  defaultTenant: () => TenantScope;
  /** Kill-switch do multi-tenant (`TENANT_ROUTING`): desligado, só o default é acessível. */
  routingEnabled: () => boolean;
  /** Tenants ATIVOS do registry (`listActiveTenants` de infra/tenant/registry.js). */
  listActiveTenants: () => Promise<ActiveTenantRow[]>;
}

interface LinkedUserRow {
  id: string;
  name: string;
  role: string;
  photo_path: string | null;
}

export class PgIdentityTenantReader implements IdentityTenantReader {
  constructor(private readonly deps: IdentityTenantReaderDeps) {}

  async listCompaniesForAccount(accountId: string): Promise<CompanySummary[]> {
    const companies: CompanySummary[] = [];
    for (const tenant of await this.candidates()) {
      const linked = await this.findLinkedUserInTenant(tenant, accountId);
      if (!linked) continue;
      try {
        const brand = await this.deps.brand.read(tenant);
        companies.push({
          slug: tenant.slug,
          name: brand.name,
          logoUrl: brand.logoUrl,
          primaryColor: brand.primaryColor,
        });
      } catch (err) {
        // Schema citado no registry mas não provisionado: a loja simplesmente
        // não aparece para a conta (o `console.error` fica no brand reader).
        if (err instanceof AppError && err.code === "tenant_schema_unavailable") continue;
        throw err;
      }
    }
    return companies;
  }

  async findLinkedUser(slug: string, accountId: string): Promise<LinkedUserRecord | null> {
    const scope = await this.resolveScope(slug);
    if (!scope) return null;
    return this.findLinkedUserInTenant(scope, accountId);
  }

  /** Candidatos: default PRIMEIRO, depois os ativos do registry (dedup por slug). */
  private async candidates(): Promise<TenantScope[]> {
    const bySlug = new Map<string, TenantScope>();
    const fallback = this.deps.defaultTenant();
    bySlug.set(fallback.slug, fallback);
    for (const tenant of await this.deps.listActiveTenants()) {
      if (bySlug.has(tenant.slug)) continue;
      bySlug.set(tenant.slug, {
        tenantId: tenant.id,
        slug: tenant.slug,
        isDefault: false,
      });
    }
    return [...bySlug.values()];
  }

  private async resolveScope(slug: string): Promise<TenantScope | null> {
    const fallback = this.deps.defaultTenant();
    if (slug === fallback.slug) return fallback;
    // Roteamento desligado: toda requisição resolve para o default, então uma
    // sessão de outro slug nasceria inválida — recusa aqui em vez de entregar um
    // token que o middleware rejeita na requisição seguinte.
    if (!this.deps.routingEnabled()) return null;
    const record = await this.deps.registry.findBySlug(slug);
    if (!record || record.status !== "active") return null;
    return {
      tenantId: record.id,
      slug: record.slug,
      isDefault: false,
    };
  }

  private async findLinkedUserInTenant(scope: TenantScope, accountId: string): Promise<LinkedUserRecord | null> {
    return runInTenantScope(scope, async () => {
      // Checagem EXPLÍCITA de provisionamento (mesma razão do brand reader): o
      // schema é o ÚNICO do app, e é lá que o `user` mora — se ele não
      // estiver lá, o seed não rodou.
      const provisioned = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'user' LIMIT 1`,
      );
      if (provisioned.rows.length === 0) return null;

      const { rows } = await pool.query<LinkedUserRow>(
        `SELECT id, name, role, photo_path
           FROM "user"
          WHERE account_id = $1 AND active = true
          ORDER BY created_at
          LIMIT 1`,
        [accountId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.id,
        name: row.name,
        role: row.role as UserRole,
        photoPath: row.photo_path ?? null,
      };
    });
  }
}
