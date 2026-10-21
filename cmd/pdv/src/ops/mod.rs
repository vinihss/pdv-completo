//! Operações locais da TUI/CLI.
//!
//! Tudo aqui roda **no clone local do repo**: as consultas de registry
//! (`public.tenant`) e as leituras/escritas de `store_settings` vão por `psql`
//! apontando para o `DATABASE_URL` resolvido por `ops::db` (variável de
//! ambiente → `backend/.env` → derivado do `deploy/.env.dev` do compose de
//! dev); provisionamento, reset de PIN e criação de usuário delegam para os
//! scripts `tsx` do backend.
//!
//! Sub-módulos:
//! * `db` — acesso ao Postgres: `psql`/`pg_dump` no host **ou** dentro do
//!   container do Postgres (o ambiente de dev é 100% containerizado e o host
//!   não tem cliente do Postgres instalado).
//! * `seeds` — catálogo **dinâmico** de seeds, lido do manifest do backend em
//!   runtime (`backend/src/infra/db/seeds/manifest.json`).
//!
//! Nota histórica: a `store_settings` é uma tabela de **colunas fixas**
//! (singleton `id = 'singleton'`) — não existe coluna JSONB `settings`. A CLI
//! Go lia/escrevia `settings` e por isso a edição de configurações nunca
//! funcionou no modo local. Aqui a leitura/escrita usa as colunas reais.

mod db;
mod seeds;
mod services;

use std::path::PathBuf;

use crate::config::root_path;
use crate::runner::{capture_cmd_in_dir, capture_npm_run};

// Superfície pública de `ops` (consumida pela CLI e pela TUI). O lint de
// import não usado reclama porque `ops` é um módulo privado do binário — os
// itens reexportados são a API do crate, não código morto.
#[allow(unused_imports)]
pub use db::{
  load_db_url, psql, psql_for_tenant, resolve_db_target, DbTarget,
};
#[allow(unused_imports)]
pub use seeds::{apply_seed, list_seeds, SeedInfo};
pub use services::{list_services, Service};

/// Registro de um tenant no registry `public.tenant`.
#[derive(Debug, Clone)]
pub struct TenantInfo {
  /// Id do tenant (uuid) — a identidade estável (o slug pode ser renomeado).
  pub id: String,
  pub slug: String,
  pub display_name: String,
  pub status: String,
  pub custom_domain: String,
  pub created_at: String,
}

/// Configurações da loja (`store_settings`) — subconjunto editável pela TUI.
#[derive(Debug, Clone, Default)]
pub struct StoreSettings {
  pub merchant_name: String,
  pub merchant_city: String,
  pub printer_enabled: bool,
  pub printer_auto_print: bool,
  pub uses_delivery: bool,
}

fn backend_dir() -> PathBuf {
  root_path().join("backend")
}

/// Slug reservado do tenant IMPLÍCITO (ambiente single-tenant).
///
/// Em single-tenant o app roda no schema default (`public`) e o registry
/// `public.tenant` fica vazio — ninguém provisiona tenant lá. Sem esta peça,
/// os fluxos que operam sobre um tenant (reset de PIN, adicionar usuário,
/// editar configurações, dump) ficavam sem alvo no dev, mesmo existindo um
/// `store_settings` de verdade (que vive em `public`).
pub const DEFAULT_TENANT_SLUG: &str = "default";

/// Id FIXO do tenant default — o MESMO valor do backend
/// (`backend/src/domain/tenant.ts`) e da linha criada pela migration
/// `migrations/registry/0003_tenant_id.sql`.
pub const DEFAULT_TENANT_ID: &str = "00000000-0000-0000-0000-000000000001";

/// Escapa uma string para literal SQL entre aspas simples.
fn sql_lit(s: &str) -> String {
  format!("'{}'", s.replace('\'', "''"))
}

fn bool_lit(b: bool) -> &'static str {
  if b {
    "true"
  } else {
    "false"
  }
}

/// Lista os tenants do registry `public.tenant`.
///
/// Registry VAZIO = ambiente single-tenant (o dev padrão): o app inteiro roda
/// no schema default (`public`) e ninguém insere linha no registry. Nesse
/// caso a lista traz o **tenant implícito** — o alvo real das operações de
/// banco — em vez de uma lista vazia que deixa a TUI sem nada para
/// selecionar.
pub fn list_tenants() -> Result<Vec<TenantInfo>, String> {
  let query = "SELECT id, slug, display_name, status, \
                 coalesce(custom_domain, ''), created_at::text \
                 FROM public.tenant ORDER BY slug";
  let out = psql(query, true)?;
  let mut res = Vec::new();
  for line in out.lines() {
    let line = line.trim_end();
    if line.is_empty() {
      continue;
    }
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() != 6 {
      continue;
    }
    res.push(TenantInfo {
      id: parts[0].to_string(),
      slug: parts[1].to_string(),
      display_name: parts[2].to_string(),
      status: parts[3].to_string(),
      custom_domain: parts[4].to_string(),
      created_at: parts[5].to_string(),
    });
  }
  if res.is_empty() {
    res.push(default_tenant());
  }
  Ok(res)
}

/// O tenant implícito — o schema default em ambiente single-tenant.
fn default_tenant() -> TenantInfo {
  TenantInfo {
    id: DEFAULT_TENANT_ID.to_string(),
    slug: DEFAULT_TENANT_SLUG.to_string(),
    display_name: "Padrão (default)".to_string(),
    status: "active".to_string(),
    custom_domain: String::new(),
    created_at: String::new(),
  }
}

/// Lê a linha singleton de `store_settings` DA LOJA.
///
/// No modelo por LINHA (`docs/28`) todas as lojas moram no mesmo schema: a
/// linha é escolhida pelo `app.tenant_id` da sessão (a policy de RLS), não
/// pelo schema. Sem o contexto de tenant, a sessão não vê NENHUMA linha.
pub fn get_store_settings(tenant_id: Option<&str>) -> Result<StoreSettings, String> {
  let query = "SELECT merchant_name, merchant_city, printer_enabled, printer_auto_print, \
         uses_delivery \
         FROM store_settings WHERE id = 'singleton'";
  let out = psql_for_tenant(query, true, tenant_id)?;
  let line = out.lines().find(|l| !l.trim().is_empty());
  let Some(line) = line else {
    return Err("store_settings não inicializado para a loja (rode o seed)".to_string());
  };
  let parts: Vec<&str> = line.trim_end().split('|').collect();
  if parts.len() != 5 {
    return Err(format!("resposta inesperada de store_settings: {line}"));
  }
  let bt = |s: &str| s == "t" || s == "true";
  Ok(StoreSettings {
    merchant_name: parts[0].to_string(),
    merchant_city: parts[1].to_string(),
    printer_enabled: bt(parts[2]),
    printer_auto_print: bt(parts[3]),
    uses_delivery: bt(parts[4]),
  })
}

/// Grava as configurações editáveis na linha singleton de `store_settings`
/// DA LOJA (o `app.tenant_id` da sessão decide qual linha é).
pub fn update_store_settings(
  tenant_id: Option<&str>,
  s: &StoreSettings,
) -> Result<(), String> {
  let query = format!(
    "UPDATE store_settings SET \
         merchant_name = {}, merchant_city = {}, printer_enabled = {}, \
         printer_auto_print = {}, uses_delivery = {} \
         WHERE id = 'singleton'",
    sql_lit(&s.merchant_name),
    sql_lit(&s.merchant_city),
    bool_lit(s.printer_enabled),
    bool_lit(s.printer_auto_print),
    bool_lit(s.uses_delivery),
  );
  psql_for_tenant(&query, false, tenant_id)?;
  Ok(())
}

/// Exporta o DADO da loja para um arquivo SQL.
///
/// O `pg_dump --schema` (o dump por loja do modelo antigo) **morreu** com o
/// RLS: o `pg_dump` não respeita a policy, então ele despejaria o banco
/// inteiro no arquivo de uma loja. A alternativa honesta é o export por
/// tenant: um `COPY` por tabela, filtrado pelo `tenant_id` da loja.
///
/// O `pg_dump` continua existindo para o backup do BANCO INTEIRO (é o que o
/// `deploy/backup.sh` faz) — e esse continua valendo.
pub fn dump_tenant(tenant_id: &str, output_file: &str) -> Result<(), String> {
  if tenant_id.trim().is_empty() {
    return Err("dump sem o id da loja".to_string());
  }
  db::export_tenant_to_file(tenant_id, output_file)
}

/// Provisiona um tenant novo (schema + migrations + bootstrap).
pub fn create_tenant(slug: &str, display_name: &str) -> Result<String, String> {
  let dn = if display_name.trim().is_empty() {
    slug
  } else {
    display_name
  };
  let backend = backend_dir();
  let _ = dotenvy::from_path(backend.join(".env"));
  let (code, out) = capture_cmd_in_dir(
    &backend,
    &[("SLUG", slug), ("DISPLAY_NAME", dn)],
    "npx",
    &["--yes", "tsx", "src/infra/db/provision-tenant.ts", slug, dn],
  );
  if code != 0 {
    return Err(format!("provision falhou (código {code}):\n{}", out.trim()));
  }
  Ok(out)
}

/// Reseta o PIN do manager de um tenant. Devolve a saída do script (que já
/// imprime o novo PIN).
pub fn reset_manager_pin(slug: &str, pin: &str) -> Result<String, String> {
  let backend = backend_dir();
  let _ = dotenvy::from_path(backend.join(".env"));
  let (code, out) = capture_cmd_in_dir(
    &backend,
    &[("SLUG", slug), ("PIN", pin)],
    "npx",
    &[
      "--yes",
      "tsx",
      "src/infra/db/reset-manager-pin.ts",
      slug,
      pin,
    ],
  );
  if code != 0 {
    return Err(format!(
      "reset de PIN falhou (código {code}):\n{}",
      out.trim()
    ));
  }
  Ok(out)
}

/// Adiciona um usuário a um tenant (perfil + PIN).
pub fn add_user(slug: &str, name: &str, profile: &str, pin: &str) -> Result<String, String> {
  let backend = backend_dir();
  let _ = dotenvy::from_path(backend.join(".env"));
  let (code, out) = capture_cmd_in_dir(
    &backend,
    &[
      ("SLUG", slug),
      ("USER_NAME", name),
      ("USER_PROFILE", profile),
      ("USER_PIN", pin),
    ],
    "npx",
    &[
      "--yes",
      "tsx",
      "src/infra/db/add-user.ts",
      slug,
      name,
      profile,
      pin,
    ],
  );
  if code != 0 {
    return Err(format!(
      "adição de usuário falhou (código {code}):\n{}",
      out.trim()
    ));
  }
  Ok(out)
}

/// `npm run <script>` no backend, com saída capturada.
pub fn npm_backend(script: &str) -> (i32, String) {
  capture_npm_run("backend", script, &[])
}

/// Instala as dependências do backend e do frontend (npm install).
pub fn install_dependencies() -> (bool, String) {
  let mut log = String::new();
  let mut ok = true;
  for dir in ["backend", "frontend"] {
    let (code, out) = capture_npm_install(dir);
    log.push_str(&format!("=== npm install ({dir}) — código {code} ===\n"));
    log.push_str(out.trim_end());
    log.push('\n');
    if code != 0 {
      ok = false;
      break;
    }
  }
  (ok, log)
}

/// `npm install` no diretório.
///
/// NÃO é `npm run install`: o `package.json` não tem script "install" (o npm
/// trata `npm install` como comando próprio), então `npm run install` morre
/// com `Missing script: "install"` — foi o que a tela de Setup mostrava.
fn capture_npm_install(rel_dir: &str) -> (i32, String) {
  let dir = root_path().join(rel_dir);
  capture_cmd_in_dir(&dir, &[], "npm", &["install"])
}

/// Garante `backend/.env` (copia de `.env.example` quando ausente).
pub fn ensure_backend_env() -> (bool, String) {
  let root = root_path();
  let backend = root.join("backend");
  let env = backend.join(".env");
  let example = backend.join(".env.example");
  if env.exists() {
    return (true, format!("backend/.env já existe ({}).", env.display()));
  }
  if !example.exists() {
    return (
      false,
      "backend/.env.example não encontrado — não há de onde copiar.".to_string(),
    );
  }
  match std::fs::copy(&example, &env) {
    Ok(_) => (
      true,
      format!(
        "backend/.env criado a partir de .env.example ({}).",
        env.display()
      ),
    ),
    Err(e) => (false, format!("falha ao criar backend/.env: {e}")),
  }
}

/// Lê os logs do backend: tenta `docker compose logs`, com fallback para
/// arquivos de log locais escritos pelo `setup-dev.sh`.
pub fn backend_logs(tail: usize) -> Result<Vec<String>, String> {
  let root = root_path();
  let tail_arg = tail.to_string();
  let compose_file = root.join("deploy/docker-compose.yml");
  let (code, out) = capture_cmd_in_dir(
    &root,
    &[],
    "docker",
    &[
      "compose",
      "-f",
      &compose_file.to_string_lossy(),
      "logs",
      "--no-color",
      "--tail",
      &tail_arg,
      "backend",
    ],
  );

  if code == 0 && !out.trim().is_empty() {
    return Ok(out.lines().map(|l| l.to_string()).collect());
  }

  // Fallback: arquivos de log locais (setup-dev.sh escreve nesses caminhos).
  for path in ["/tmp/pdv-backend.log", "/tmp/pdv-frontend.log"] {
    if let Ok(content) = std::fs::read_to_string(path) {
      let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
      if lines.len() > tail {
        lines = lines.split_off(lines.len() - tail);
      }
      if !lines.is_empty() {
        let mut header = vec![format!("(fallback) {path}")];
        header.extend(lines);
        return Ok(header);
      }
    }
  }

  if code != 0 {
    Err(format!(
      "não foi possível ler os logs (docker compose falhou e nenhum arquivo local encontrado):\n{}",
      out.trim()
    ))
  } else {
    Ok(vec!["(sem saída de logs)".to_string()])
  }
}

/// Instala/atualiza dependências do backend e frontend.
pub fn setup_full() -> (bool, String) {
  let mut log = String::new();
  let (ok_env, msg) = ensure_backend_env();
  log.push_str(&format!("[env] {msg}\n"));
  if !ok_env {
    return (false, log);
  }
  let (ok_deps, deps_log) = install_dependencies();
  log.push_str(&deps_log);
  if !ok_deps {
    return (false, log);
  }
  let (code, out) = npm_backend("db:migrate");
  log.push_str(&format!(
    "=== npm run db:migrate — código {code} ===\n{}\n",
    out.trim_end()
  ));
  if code != 0 {
    return (false, log);
  }
  let (code, out) = npm_backend("seed");
  log.push_str(&format!(
    "=== npm run seed — código {code} ===\n{}\n",
    out.trim_end()
  ));
  (code == 0, log)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tenant_implicito_aponta_para_o_schema_default() {
    let t = default_tenant();
    assert_eq!(t.slug, DEFAULT_TENANT_SLUG);
    assert_eq!(t.id, DEFAULT_TENANT_ID);
    assert_eq!(t.status, "active");
    assert_eq!(t.display_name, "Padrão (default)");
  }


}
