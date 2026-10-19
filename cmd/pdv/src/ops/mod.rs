//! Operações locais da TUI/CLI.
//!
//! Tudo aqui roda **no clone local do repo**: as consultas de registry
//! (`public.tenant`) e as leituras/escritas de `store_settings` vão por `psql`
//! apontando para o `DATABASE_URL` de `backend/.env`; provisionamento, reset de
//! PIN e criação de usuário delegam para os scripts `tsx` do backend.
//!
//! Nota histórica: a `store_settings` é uma tabela de **colunas fixas**
//! (singleton `id = 'singleton'`) — não existe coluna JSONB `settings`. A CLI
//! Go lia/escrevia `settings` e por isso a edição de configurações nunca
//! funcionou no modo local. Aqui a leitura/escrita usa as colunas reais.

mod services;

use std::path::PathBuf;

use crate::config::root_path;
use crate::runner::{capture_cmd_in_dir, capture_npm_run};

pub use services::{list_services, Service};

/// Registro de um tenant no registry `public.tenant`.
#[derive(Debug, Clone)]
pub struct TenantInfo {
  pub slug: String,
  pub schema_name: String,
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
  pub whatsapp_integration_enabled: bool,
}

fn backend_dir() -> PathBuf {
  root_path().join("backend")
}

/// Lê o `DATABASE_URL` do ambiente ou de `backend/.env`.
fn load_db_url(backend: &std::path::Path) -> String {
  if let Ok(db) = std::env::var("DATABASE_URL") {
    if !db.trim().is_empty() {
      return db;
    }
  }
  let _ = dotenvy::from_path(backend.join(".env"));
  std::env::var("DATABASE_URL").unwrap_or_default()
}

/// Nome de schema aceito: `tenant_<minúsculas/números/underscore>`.
fn valid_schema(schema: &str) -> bool {
  let Some(rest) = schema.strip_prefix("tenant_") else {
    return false;
  };
  !rest.is_empty()
    && rest
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

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

/// Roda um `psql` com saída em colunas `|` e retorna o stdout.
fn psql(sql: &str, tuples_only: bool) -> Result<String, String> {
  let backend = backend_dir();
  let db_url = load_db_url(&backend);
  if db_url.is_empty() {
    return Err("DATABASE_URL não definido (backend/.env ausente?)".into());
  }
  let mut args: Vec<&str> = vec![&db_url, "-v", "ON_ERROR_STOP=1"];
  if tuples_only {
    args.extend_from_slice(&["-t", "-A", "-F", "|"]);
  }
  args.extend_from_slice(&["-c", sql]);

  let (code, out) = capture_cmd_in_dir(&backend, &[], "psql", &args);
  if code != 0 {
    return Err(format!("psql falhou:\n{}", out.trim()));
  }
  Ok(out)
}

/// Lista os tenants do registry `public.tenant`.
pub fn list_tenants() -> Result<Vec<TenantInfo>, String> {
  let query = "SELECT slug, schema_name, display_name, status, \
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
      slug: parts[0].to_string(),
      schema_name: parts[1].to_string(),
      display_name: parts[2].to_string(),
      status: parts[3].to_string(),
      custom_domain: parts[4].to_string(),
      created_at: parts[5].to_string(),
    });
  }
  Ok(res)
}

/// Lê a linha singleton de `store_settings` do schema do tenant.
pub fn get_store_settings(schema: &str) -> Result<StoreSettings, String> {
  if !valid_schema(schema) {
    return Err(format!("nome de schema inválido: {schema}"));
  }
  let query = format!(
    "SELECT merchant_name, merchant_city, printer_enabled, printer_auto_print, \
         uses_delivery, whatsapp_integration_enabled \
         FROM {schema}.store_settings WHERE id = 'singleton'"
  );
  let out = psql(&query, true)?;
  let line = out.lines().find(|l| !l.trim().is_empty());
  let Some(line) = line else {
    return Err(format!(
      "store_settings não inicializado no schema {schema} (rode o seed)"
    ));
  };
  let parts: Vec<&str> = line.trim_end().split('|').collect();
  if parts.len() != 6 {
    return Err(format!("resposta inesperada de store_settings: {line}"));
  }
  let bt = |s: &str| s == "t" || s == "true";
  Ok(StoreSettings {
    merchant_name: parts[0].to_string(),
    merchant_city: parts[1].to_string(),
    printer_enabled: bt(parts[2]),
    printer_auto_print: bt(parts[3]),
    uses_delivery: bt(parts[4]),
    whatsapp_integration_enabled: bt(parts[5]),
  })
}

/// Grava as configurações editáveis na linha singleton de `store_settings`.
pub fn update_store_settings(schema: &str, s: &StoreSettings) -> Result<(), String> {
  if !valid_schema(schema) {
    return Err(format!("nome de schema inválido: {schema}"));
  }
  let query = format!(
    "UPDATE {schema}.store_settings SET \
         merchant_name = {}, merchant_city = {}, printer_enabled = {}, \
         printer_auto_print = {}, uses_delivery = {}, whatsapp_integration_enabled = {} \
         WHERE id = 'singleton'",
    sql_lit(&s.merchant_name),
    sql_lit(&s.merchant_city),
    bool_lit(s.printer_enabled),
    bool_lit(s.printer_auto_print),
    bool_lit(s.uses_delivery),
    bool_lit(s.whatsapp_integration_enabled),
  );
  psql(&query, false)?;
  Ok(())
}

/// Exporta o schema do tenant para um arquivo SQL (`pg_dump --schema`).
pub fn dump_tenant(schema: &str, output_file: &str) -> Result<(), String> {
  if !valid_schema(schema) {
    return Err(format!("nome de schema inválido: {schema}"));
  }
  let backend = backend_dir();
  let db_url = load_db_url(&backend);
  if db_url.is_empty() {
    return Err("DATABASE_URL não definido (backend/.env ausente?)".into());
  }
  let schema_arg = format!("--schema={schema}");
  let file_arg = format!("--file={output_file}");
  let (code, out) =
    capture_cmd_in_dir(&backend, &[], "pg_dump", &[&db_url, &schema_arg, &file_arg]);
  if code != 0 {
    return Err(format!("pg_dump falhou:\n{}", out.trim()));
  }
  Ok(())
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
    let (code, out) = capture_npm_run(dir, "install", &[]);
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
