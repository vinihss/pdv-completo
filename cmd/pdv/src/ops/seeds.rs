//! Catálogo **dinâmico** de seeds + aplicação.
//!
//! O catálogo vive em `backend/src/infra/db/seeds/manifest.json` e é lido em
//! **runtime**: adicionar um seed novo é mexer no manifest (e no
//! `package.json` do backend), **não** em recompilar a CLI.
//!
//! Aplicação: o seed roda pelo `npm run <npmScript>` do backend — no host,
//! quando `backend/node_modules` existe, ou dentro do container do backend
//! (`docker exec`), quando o ambiente é 100% containerizado (é o padrão do
//! `pdv setup`: o host só precisa do Docker).

use std::path::PathBuf;

use crate::config::root_path;
use crate::ops::db;
use crate::runner::capture_cmd_in_dir;

/// Um seed do catálogo.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SeedInfo {
  /// Identificador curto e estável (`pdv db seed <id>`).
  pub id: String,
  /// Nome curto exibido na lista.
  pub title: String,
  /// O que o seed faz, em uma linha.
  pub description: String,
  /// Script npm do backend que executa o seed (ex.: `seed:demo`).
  #[serde(rename = "npmScript")]
  pub npm_script: String,
  /// Verdadeiro se o seed apaga/sobrescreve dados existentes.
  pub destructive: bool,
  /// Verdadeiro se o seed pode rodar em produção.
  #[serde(rename = "productionSafe")]
  pub production_safe: bool,
  /// Verdadeiro se o seed usa funções PostGIS (`ST_*`) — exige a extensão.
  #[serde(rename = "requiresPostgis")]
  pub requires_postgis: bool,
}

/// Envelope do manifest (o resto das chaves — `$schema`, `version` — é
/// ignorado pelo serde).
#[derive(Debug, serde::Deserialize)]
struct Manifest {
  #[serde(default)]
  seeds: Vec<SeedInfo>,
}

/// Caminho do manifest dos seeds.
pub fn manifest_path() -> PathBuf {
  root_path().join("backend/src/infra/db/seeds/manifest.json")
}

/// Parseia o JSON do manifest (função pura — testada com JSON de exemplo).
pub fn parse_manifest(raw: &str) -> Result<Vec<SeedInfo>, String> {
  let manifest: Manifest =
    serde_json::from_str(raw).map_err(|e| format!("manifest de seeds inválido: {e}"))?;
  if manifest.seeds.is_empty() {
    return Err("manifest de seeds inválido: nenhum seed declarado".into());
  }
  Ok(manifest.seeds)
}

/// Lista os seeds declarados no manifest do backend.
pub fn list_seeds() -> Result<Vec<SeedInfo>, String> {
  let path = manifest_path();
  let raw = match std::fs::read_to_string(&path) {
    Ok(raw) => raw,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      return Err(format!(
        "manifest de seeds não encontrado em {}",
        path.display()
      ));
    }
    Err(e) => {
      return Err(format!(
        "não consegui ler o manifest de seeds em {}: {e}",
        path.display()
      ));
    }
  };
  parse_manifest(&raw).map_err(|e| format!("{} ({})", e, path.display()))
}

/// Procura um seed pelo id (função pura — testada com o manifest de exemplo).
pub fn find_seed<'a>(seeds: &'a [SeedInfo], id: &str) -> Option<&'a SeedInfo> {
  seeds.iter().find(|s| s.id == id)
}

/// Aplica o seed de id `id` e devolve a saída do comando.
///
/// Ordem: procura o id no manifest → preflight de PostGIS (quando o seed
/// exige) → executa o `npm run <npmScript>` (host ou container).
pub fn apply_seed(id: &str) -> Result<String, String> {
  let seeds = list_seeds()?;
  let Some(seed) = find_seed(&seeds, id) else {
    let ids: Vec<&str> = seeds.iter().map(|s| s.id.as_str()).collect();
    let available = if ids.is_empty() {
      "(nenhum)".to_string()
    } else {
      ids.join(", ")
    };
    return Err(format!(
      "seed desconhecido: '{id}'\ndisponíveis: {available} (veja `pdv db seeds`)"
    ));
  };

  if seed.requires_postgis {
    preflight_postgis(seed)?;
  }

  run_seed(seed)
}

/// Confere que o banco responde a `postgis_version()` antes de rodar um seed
/// que usa funções PostGIS.
fn preflight_postgis(seed: &SeedInfo) -> Result<(), String> {
  match db::psql("SELECT postgis_version()", true) {
    Ok(out) => {
      let v = out.trim();
      if v.is_empty() || v.contains("(null)") {
        Err(postgis_error(
          seed,
          "o banco respondeu sem versão do PostGIS",
        ))
      } else {
        Ok(())
      }
    }
    Err(e) => Err(postgis_error(seed, &e)),
  }
}

/// Mensagem de erro do preflight de PostGIS.
fn postgis_error(seed: &SeedInfo, cause: &str) -> String {
  format!(
    "o seed '{id}' exige PostGIS, mas o banco não respondeu a `postgis_version()`:\n{cause}\n\n\
     Causas possíveis:\n\
     (a) a extensão está **registrada** em `pg_extension`, mas a **biblioteca** do PostGIS não está \
     na imagem do Postgres (imagem `postgres:16-alpine` em vez de `postgis/postgis:16-3.5-alpine`) — \
     daí o erro `could not access file \"$libdir/postgis-3\"`;\n\
     (b) a extensão nem existe neste banco (`CREATE EXTENSION postgis`).\n\
     Como resolver: subir o Postgres com a imagem que traz o PostGIS \
     (`deploy/docker-compose.override.yml` já usa `postgis/postgis:16-3.5-alpine`) e recriar o \
     banco; ou aplicar um seed que não dependa de PostGIS (`base`, `prod`).",
    id = seed.id
  )
}

/// Executa o script npm do seed: no host quando `backend/node_modules` existe,
/// dentro do container do backend quando não existe.
fn run_seed(seed: &SeedInfo) -> Result<String, String> {
  let backend = root_path().join("backend");
  if backend.join("node_modules").is_dir() {
    // O seed roda no host e precisa da MESMA URL que a CLI usa. Quando não
    // existe `backend/.env` (o arquivo é gitignored e o ambiente de dev é tudo
    // em containers), a URL veio do `deploy/.env.dev` — sem exportá-la, o
    // backend aborta com "DATABASE_URL é obrigatório".
    let url = db::load_db_url();
    let envs: Vec<(&str, &str)> = if url.trim().is_empty() {
      Vec::new()
    } else {
      vec![("DATABASE_URL", url.as_str())]
    };
    let (code, out) =
      capture_cmd_in_dir(&backend, &envs, "npm", &["run", seed.npm_script.as_str()]);
    if code != 0 {
      return Err(format!(
        "seed '{}' falhou (código {code}) — `npm run {}`:\n{}",
        seed.id,
        seed.npm_script,
        out.trim()
      ));
    }
    return Ok(out);
  }

  if let Some(container) = find_backend_container() {
    // A imagem de DEV tem `src/` + `tsx` (o `npm run <script>` funciona); a
    // imagem de PRODUÇÃO só tem `dist/` — o `npm prune --omit=dev` tira o
    // `tsx` e o Dockerfile não copia o `src/`. Nos dois casos existe o
    // runner genérico, então a imagem de produção roda
    // `node dist/infra/db/seeds/apply.js <id>`.
    if container_has(&container, "/app/src/infra/db/seeds/apply.ts") {
      let (code, out) = capture_cmd_in_dir(
        &root_path(),
        &[],
        "docker",
        &["exec", &container, "npm", "run", seed.npm_script.as_str()],
      );
      if code != 0 {
        return Err(format!(
          "seed '{}' falhou (código {code}) — `docker exec {container} npm run {}`:\n{}",
          seed.id,
          seed.npm_script,
          out.trim()
        ));
      }
      return Ok(out);
    }

    if container_has(&container, "/app/dist/infra/db/seeds/apply.js") {
      let (code, out) = capture_cmd_in_dir(
        &root_path(),
        &[],
        "docker",
        &[
          "exec",
          &container,
          "node",
          "dist/infra/db/seeds/apply.js",
          seed.id.as_str(),
        ],
      );
      if code != 0 {
        return Err(format!(
          "seed '{}' falhou (código {code}) — `docker exec {container} node dist/infra/db/seeds/apply.js {}`:\n{}",
          seed.id,
          seed.id,
          out.trim()
        ));
      }
      return Ok(out);
    }

    return Err(format!(
      "o container '{container}' não tem nem `src/infra/db/seeds/apply.ts` (imagem de dev) \
       nem `dist/infra/db/seeds/apply.js` (imagem de produção) — não sei como aplicar o seed '{}'.",
      seed.id
    ));
  }

  Err(format!(
    "não achei como aplicar o seed '{}':\n\
     (a) `backend/node_modules` não existe no host — rode `npm install` dentro de `backend/`; ou\n\
     (b) não há container do backend rodando — suba o ambiente com `pdv setup`.",
    seed.id
  ))
}

/// O container tem este arquivo? (sonda `docker exec <c> test -f <path>`).
fn container_has(container: &str, path: &str) -> bool {
  let (code, _) = capture_cmd_in_dir(
    &root_path(),
    &[],
    "docker",
    &["exec", container, "test", "-f", path],
  );
  code == 0
}

/// Nome do container do backend rodando (label do compose).
///
/// `PDV_BACKEND_CONTAINER` fixa o container quando há mais de um stack na
/// máquina.
pub fn find_backend_container() -> Option<String> {
  if let Ok(name) = std::env::var("PDV_BACKEND_CONTAINER") {
    if !name.trim().is_empty() {
      return Some(name.trim().to_string());
    }
  }
  let args = [
    "ps",
    "--filter",
    "label=com.docker.compose.service=backend",
    "--format",
    "{{.Names}}",
  ];
  let (code, out) = capture_cmd_in_dir(&root_path(), &[], "docker", &args);
  if code != 0 {
    return None;
  }
  out
    .lines()
    .map(str::trim)
    .find(|l| !l.is_empty())
    .map(|l| l.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  const SAMPLE: &str = r#"{
    "$schema": "./manifest.schema.json",
    "version": 1,
    "seeds": [
      {
        "id": "base",
        "title": "Seed base (dados essenciais)",
        "description": "store_settings, usuários de teste, categorias, produtos",
        "npmScript": "seed:base",
        "destructive": false,
        "productionSafe": false,
        "requiresPostgis": false
      },
      {
        "id": "demo",
        "title": "Seed de demonstração (catálogo + histórico)",
        "description": "seed base + catálogo demo e histórico",
        "npmScript": "seed:demo",
        "destructive": false,
        "productionSafe": false,
        "requiresPostgis": true
      },
      {
        "id": "prod",
        "title": "Seed de produção (bootstrap do primeiro deploy)",
        "description": "store_settings + manager com PIN temporário",
        "npmScript": "seed:prod",
        "destructive": false,
        "productionSafe": true,
        "requiresPostgis": false
      }
    ]
  }"#;

  #[test]
  fn parseia_manifest_completo() {
    let seeds = parse_manifest(SAMPLE).unwrap();
    assert_eq!(seeds.len(), 3);
    assert_eq!(seeds[0].id, "base");
    assert_eq!(seeds[0].npm_script, "seed:base");
    assert!(!seeds[0].destructive);
    assert!(!seeds[0].production_safe);
    assert!(!seeds[0].requires_postgis);
    assert!(seeds[1].requires_postgis);
    assert!(seeds[2].production_safe);
  }

  #[test]
  fn manifest_invalido_vira_erro() {
    let err = parse_manifest("{ nao é json").unwrap_err();
    assert!(err.contains("manifest de seeds inválido"), "erro: {err}");
  }

  #[test]
  fn manifest_sem_seeds_vira_erro() {
    let err = parse_manifest(r#"{"version": 1, "seeds": []}"#).unwrap_err();
    assert!(err.contains("nenhum seed declarado"), "erro: {err}");
  }

  #[test]
  fn seed_desconhecido_lista_os_disponiveis() {
    let seeds = parse_manifest(SAMPLE).unwrap();
    let ids: Vec<&str> = seeds.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["base", "demo", "prod"]);
    assert!(seeds.iter().any(|s| s.id == "demo"));
    assert!(!seeds.iter().any(|s| s.id == "nao-existe"));
  }

  #[test]
  fn resolucao_por_id_escolhe_o_seed_certo() {
    let seeds = parse_manifest(SAMPLE).unwrap();
    let prod = find_seed(&seeds, "prod").expect("seed prod");
    assert_eq!(prod.npm_script, "seed:prod");
    assert!(prod.production_safe);
    assert!(!prod.requires_postgis);
    assert!(find_seed(&seeds, "nao-existe").is_none());
  }

  #[test]
  fn mensagem_de_postgis_menciona_a_biblioteca() {
    let seed = parse_manifest(SAMPLE).unwrap().remove(1);
    let msg = postgis_error(&seed, "could not access file \"$libdir/postgis-3\"");
    assert!(msg.contains("postgis_version()"), "mensagem: {msg}");
    assert!(msg.contains("postgis/postgis"), "mensagem: {msg}");
    assert!(msg.contains("registrada"), "mensagem: {msg}");
    assert!(msg.contains("CREATE EXTENSION postgis"), "mensagem: {msg}");
  }
}
