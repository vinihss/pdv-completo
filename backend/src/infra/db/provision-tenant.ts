// Provisiona um TENANT novo (Fase 3 do `docs/15-multi-tenant-schema.md` §6.1):
// cria o schema `tenant_<slug>` no banco e aplica as migrations dentro dele —
// a loja nasce com o DDL exato de produção numa única passada, sem replay da
// cadeia velha (§6.0.2 do doc 15).
//
// Uso (dentro do container do backend, uma vez por tenant):
//   SLUG=umami DISPLAY_NAME="Umami Sushi" node dist/infra/db/provision-tenant.js
//
// Depois de rodar, o tenant aparece em `public.tenant` e o próximo boot o
// inclui no loop de migrations do startup (`server.ts#main`).
import { pool } from "./client.js";
import { runMigrations } from "./migrate.js";
import { runRegistryMigrations } from "./registry-migrate.js";
import { closeDatabase } from "./client.js";

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

  return schemaName;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.env.SLUG ?? process.argv[2];
  const displayName = process.env.DISPLAY_NAME ?? process.argv[3] ?? slug;
  if (!slug) {
    console.error("uso: SLUG=umami DISPLAY_NAME=\"...\" node dist/infra/db/provision-tenant.js");
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
