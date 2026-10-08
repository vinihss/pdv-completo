// Provisiona um TENANT novo (Fase 3 do `docs/15-multi-tenant-schema.md` §6.1):
// cria o schema `tenant_<slug>` no banco e aplica as migrations dentro dele —
// a loja nasce com o DDL exato de produção numa única passada, sem replay da
// cadeia velha (§6.0.2 do doc 15).
//
// Uso (dentro do container do backend, uma vez por tenant):
//   SLUG=umami DISPLAY_NAME="Umami Sushi" node dist/infra/db/provision-tenant.js
// No repo o caminho curto é `./pdv db provision umami "Umami Sushi"`.
//
// Depois de rodar, o tenant aparece em `public.tenant` e o próximo boot o
// inclui no loop de migrations do startup (`server.ts#main`).
//
// O passo final é o BOOTSTRAP de dados (`runProdSeed`, o mesmo do
// `db:seed:prod`): `store_settings` + um manager inicial com PIN impresso no
// log — sem isso a loja nova abre e estoura "store_settings não inicializado"
// (`order.usecases.ts`). Ele roda DENTRO do escopo ALS do schema novo, então o
// `db` (Proxy por ALS) grava em `tenant_<slug>`. `SEED=0` pula o bootstrap.
import { pool, closeDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";
import { runRegistryMigrations } from "./registry-migrate.js";
import { runInTenantScope } from "./tenant-context.js";
import { runProdSeed } from "./seed-prod.js";

export async function provisionTenantSchema(slug: string, displayName: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug} (use letras minúsculas, números e hífen)`);
  }
  const schemaName = `tenant_${slug.replace(/-/g, "_")}`;

  // Registry existe antes de qualquer tenant: garante a tabela `public.tenant`.
  await runRegistryMigrations();

  const admin = await pool.connect();
  try {
    // O schema precisa existir ANTES do pool dedicado rodar migrations:
    // o pool fala com `search_path=tenant_x,public,pg_temp`, e sem o schema
    // o primeiro `CREATE TABLE` cai em `public`.
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  } finally {
    admin.release();
  }

  // Mesmo DDL das migrations de produção, agora dentro do schema do tenant.
  await runMigrations({ schema: schemaName });

  // Linha no registry: o `resolveTenant` passa a aceitar o subdomínio.
  await pool.query(
    `INSERT INTO public.tenant (slug, schema_name, display_name, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (slug) DO UPDATE SET schema_name = EXCLUDED.schema_name, display_name = EXCLUDED.display_name`,
    [slug, schemaName, displayName],
  );

  // Bootstrap de dados no schema recém-migrado. `runInTenantScope` faz o ALS
  // apontar para o tenant, e como `db`/`pool` são Proxies que leem o ALS
  // (`client.ts`), o seed inteiro cai em `tenant_<slug>` sem SQL próprio.
  const skipSeed = ["1", "true", "yes", "on"].includes((process.env.SEED ?? "").toLowerCase());
  if (skipSeed) {
    console.log(`[provision] SEED=0 — bootstrap pulado (schema vazio de dados)`);
  } else {
    await runInTenantScope({ schemaName, isDefault: false }, () =>
      runProdSeed({ merchantName: displayName }),
    );
  }

  return schemaName;
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
    .then(async (schemaName) => {
      console.log(`[provision] tenant "${slug}" pronto no schema ${schemaName}`);
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[provision] falhou: ${(err as Error).message}`);
      await closeDatabase();
      process.exit(1);
    });
}
