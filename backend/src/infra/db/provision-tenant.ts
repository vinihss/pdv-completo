// Provisiona um TENANT novo (Fase 3 do `docs/28-multitenant-row-level.md`):
// registra a loja no registry e roda o BOOTSTRAP de dados (`runProdSeed`, o
// mesmo do `db:seed:prod`): `store_settings` + um manager inicial com PIN
// impresso no log — sem isso a loja nova abre e estoura "store_settings não
// inicializado" (`order.usecases.ts`).
//
// NO MODELO POR LINHA A LOJA NÃO TEM SCHEMA. O `docs/15` (schema-por-loja)
// criou um schema `tenant_<slug>` por loja; o `docs/28` trocou isso por uma
// única coluna `tenant_id` + RLS. O que era DDL por loja (`CREATE SCHEMA` +
// migrations dentro) não existe mais: as migrations rodam UMA vez (no schema
// do app) e o que separa uma loja da outra é a coluna `tenant_id`.
//
// Uso (dentro do container do backend, uma vez por tenant):
//   SLUG=umami DISPLAY_NAME="Umami Sushi" node dist/infra/db/provision-tenant.js
// No repo o caminho curto é `./pdv db provision umami "Umami Sushi"`.
//
// Depois de rodar, o tenant aparece em `public.tenant` e o próximo boot o
// inclui no loop de migrations do startup (`server.ts#main`).
//
// O BOOTSTRAP roda DENTRO do escopo ALS do tenant: `runInTenantScope` faz o
// ALS apontar para a loja, e como `db`/`pool` são Proxies que leem o ALS
// (`client.ts`), o seed inteiro cai na loja nova (`tenant_id` = o id dela)
// sem SQL próprio. `SEED=0` pula o bootstrap.
import { pool, closeDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";
import { runRegistryMigrations } from "./registry-migrate.js";
import { runInTenantScope } from "./tenant-context.js";
import { runProdSeed } from "./seed-prod.js";

export async function provisionTenantSchema(slug: string, displayName: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug} (use letras minúsculas, números e hífen)`);
  }

  // Registry existe antes de qualquer tenant: garante a tabela `public.tenant`.
  await runRegistryMigrations();

  // As migrations do schema do app (uma vez só — o `tenant_id` separa as
  // lojas). O dono aplica; o papel do app não tem DDL.
  await runMigrations();

  // Linha no registry: o `resolveTenant` passa a aceitar o subdomínio.
  //
  // O `id` (uuid) é a identidade ESTÁVEL do tenant — é o que vai para a coluna
  // `tenant_id` das linhas e para o `app.tenant_id` da conexão (é o que a
  // policy de RLS compara). `RETURNING id` devolve o id da linha que ficou
  // (nova ou já existente), e é ele que o escopo ALS carrega: o
  // `app.tenant_id` gravado na transação tem que ser o id do banco, não um
  // slug recriado às cegas.
  //
  // O `schema_name` ainda existe (a coluna sai na F3c) e vale `public` para
  // toda loja — o schema é único. O seu UNIQUE já foi derrubado na `0015`.
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
     VALUES (gen_random_uuid(), $1, 'public', $2, 'active')
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [slug, displayName],
  );
  const tenantId = inserted.rows[0]?.id;
  if (!tenantId) {
    throw new Error(`não consegui obter o id do tenant "${slug}" ao registrá-lo no registry`);
  }

  // Bootstrap de dados da loja nova: `runInTenantScope` faz o ALS apontar
  // para o tenant, e o seed inteiro cai na loja dele (o `tenant_id` vai no
  // `app.tenant_id` da conexão e o trigger preenche a coluna das linhas).
  const skipSeed = ["1", "true", "yes", "on"].includes((process.env.SEED ?? "").toLowerCase());
  if (skipSeed) {
    console.log(`[provision] SEED=0 — bootstrap pulado (loja sem dados)`);
  } else {
    await runInTenantScope({ tenantId, slug, isDefault: false }, () =>
      runProdSeed({ merchantName: displayName }),
    );
  }

  return tenantId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `??` não cobre string vazia: o dispatcher (Go, `cmd/pdv`) passa
  // DISPLAY_NAME="" quando o usuário não informou o nome, e cairia no
  // `?? slug` só com `.trim() ||`. Mesma coisa para o SLUG.
  const slug = (process.env.SLUG ?? "").trim() || process.argv[2];
  const displayName = (process.env.DISPLAY_NAME ?? "").trim() || process.argv[3] || slug;
  if (!slug) {
    console.error("uso: SLUG=umami DISPLAY_NAME=\"...\" node dist/infra/db/provision-tenant.js");
    console.error("ou:  npm run db:provision -- umami \"Umami Sushi\"");
    console.error("ou (dev): tsx src/infra/db/provision-tenant.ts umami \"Umami Sushi\"");
    process.exit(1);
  }
  provisionTenantSchema(slug, displayName)
    .then(async (tenantId) => {
      console.log(`[provision] tenant "${slug}" pronto (id ${tenantId})`);
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[provision] falhou: ${(err as Error).message}`);
      await closeDatabase();
      process.exit(1);
    });
}
