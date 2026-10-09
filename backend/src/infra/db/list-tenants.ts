import { pool, closeDatabase } from "./client.js";

async function listTenants() {
  const { rows } = await pool.query(
    "SELECT slug, schema_name, display_name, status FROM public.tenant ORDER BY slug"
  );
  
  if (rows.length === 0) {
    console.log("Nenhum tenant encontrado no registry.");
  } else {
    console.log("\nTenants cadastrados:");
    console.log("─".repeat(60));
    console.log("Slug".padEnd(20) + "Schema".padEnd(25) + "Nome".padEnd(15) + "Status");
    console.log("─".repeat(60));
    for (const row of rows) {
      console.log(
        row.slug.padEnd(20) +
        row.schema_name.padEnd(25) +
        (row.display_name || "").padEnd(15) +
        row.status
      );
    }
    console.log("─".repeat(60));
    console.log(`Total: ${rows.length} tenant(s)\n`);
  }
  
  await closeDatabase();
}

listTenants().catch((err) => {
  console.error("Erro:", err.message);
  closeDatabase().then(() => process.exit(1));
});
