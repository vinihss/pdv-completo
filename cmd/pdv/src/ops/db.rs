//! Acesso ao Postgres com **duas estratégias**: binário no host (`psql`/
//! `pg_dump`) ou `docker exec` no container do Postgres.
//!
//! O ambiente de dev do PDV roda **tudo em containers** (`pdv setup` → docker
//! compose) e o host não precisa — e não tem — `psql`/`pg_dump` instalados.
//! Chamar o binário direto quebrava a TUI ("Listar tenants", "Editar
//! configurações", "Backup/dump do tenant") num host limpo.
//!
//! Regras:
//! * **Host**: `psql`/`pg_dump` no `PATH` — comportamento de sempre.
//! * **Container**: `docker exec <container> psql …`, com o container
//!   descoberto por `docker ps --filter
//!   "label=com.docker.compose.service=postgres"` (vale para o stack de dev
//!   `pdv-dev-postgres-1` e para o de produção).
//! * O fallback de container só é usado quando a `DATABASE_URL` aponta para a
//!   **máquina local** (`localhost`/`127.0.0.1`) **e** existe um container de
//!   Postgres rodando. URL remota → o fallback não se aplica (o container é
//!   outro banco, não o da URL) e o erro manda instalar o `psql` no host.
//!
//! Dentro do container a URL continua válida: o Postgres do compose é o
//! próprio banco, então o host vira `localhost` e a porta, `5432` (a porta
//! interna do container — a porta publicada no host pode ser outra).

use std::path::PathBuf;

use crate::config::root_path;
use crate::runner::capture_cmd_in_dir;

/// Onde o `psql`/`pg_dump` da CLI roda.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbTarget {
  /// Binário do Postgres instalado no host (`psql`/`pg_dump` no `PATH`).
  Host,
  /// Container do Postgres (nome do container).
  Container(String),
}

impl DbTarget {
  /// Descrição curta, para mensagens de erro.
  pub fn label(&self) -> String {
    match self {
      DbTarget::Host => "psql no host".to_string(),
      DbTarget::Container(c) => format!("docker exec {c}"),
    }
  }
}

fn backend_dir() -> PathBuf {
  root_path().join("backend")
}

/// Lê o `DATABASE_URL` do ambiente ou de `backend/.env`.
pub fn load_db_url() -> String {
  if let Ok(db) = std::env::var("DATABASE_URL") {
    if !db.trim().is_empty() {
      return db;
    }
  }
  let backend = backend_dir();
  let _ = dotenvy::from_path(backend.join(".env"));
  let from_env_file = std::env::var("DATABASE_URL").unwrap_or_default();
  if !from_env_file.trim().is_empty() {
    return from_env_file;
  }
  // Sem `backend/.env` (o arquivo é gitignored e o ambiente de dev é tudo em
  // containers): deriva do env do compose de dev, que o `pdv setup` gera.
  db_url_from_dev_env().unwrap_or_default()
}

/// Caminho do env de dev gerado pelo `pdv setup` (`deploy/.env.dev`).
fn dev_env_path() -> PathBuf {
  root_path().join("deploy/.env.dev")
}

/// Valor de uma chave do `deploy/.env.dev` (`KEY=VALUE`, comentário com `#`).
fn dev_env_value(key: &str) -> Option<String> {
  let content = std::fs::read_to_string(dev_env_path()).ok()?;
  dev_env_value_in(&content, key)
}

/// Mesma leitura, sobre um conteúdo já carregado (função pura — testada).
fn dev_env_value_in(content: &str, key: &str) -> Option<String> {
  for line in content.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let Some((k, v)) = line.split_once('=') else {
      continue;
    };
    if k.trim() == key {
      let v = v.trim();
      if !v.is_empty() {
        return Some(v.to_string());
      }
    }
  }
  None
}

/// URL do Postgres **no host**, derivada do env de dev.
///
/// O compose usa o nome do serviço (`postgres:5432`) porque o backend roda
/// dentro da rede do projeto; do lado do host o mesmo banco está em
/// `localhost:<porta publicada>` (a porta é variável: `setup-dev.sh` escolhe a
/// primeira livre e grava em `deploy/.env.dev`).
pub fn db_url_from_dev_env() -> Option<String> {
  let user = dev_env_value("POSTGRES_USER").unwrap_or_else(|| "pdv".to_string());
  let pass = dev_env_value("POSTGRES_PASSWORD").unwrap_or_else(|| "pdv_password".to_string());
  let db = dev_env_value("POSTGRES_DB").unwrap_or_else(|| "pdv".to_string());
  let port = dev_env_value("DEV_POSTGRES_PORT").unwrap_or_else(|| "5432".to_string());
  Some(format!("postgres://{user}:{pass}@localhost:{port}/{db}"))
}

/// Host da URL (sem usuário, senha e porta).
pub fn url_host(url: &str) -> Option<String> {
  let rest = url.split_once("://").map(|(_, r)| r)?;
  let authority = match rest.find(['/', '?']) {
    Some(i) => &rest[..i],
    None => rest,
  };
  let host_port = match authority.rsplit_once('@') {
    Some((_, hp)) => hp,
    None => authority,
  };
  let host = match host_port.rsplit_once(':') {
    // Só trata como porta quando o que vem depois é numérico (senão é um
    // host IPv6 entre colchetes).
    Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
    _ => host_port,
  };
  let host = host.trim_start_matches('[').trim_end_matches(']');
  if host.is_empty() {
    None
  } else {
    Some(host.to_string())
  }
}

/// A URL aponta para a máquina local?
pub fn is_local_host(host: &str) -> bool {
  matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Reescreve host/porta da URL para o container do Postgres
/// (`localhost:5432` — o banco é o próprio container). Usuário, senha, nome do
/// banco e query string (`?sslmode=…`) são preservados.
pub fn rewrite_url_for_container(url: &str) -> String {
  let Some((scheme, rest)) = url.split_once("://") else {
    return url.to_string();
  };
  let (authority, tail) = match rest.find(['/', '?']) {
    Some(i) => (&rest[..i], &rest[i..]),
    None => (rest, ""),
  };
  let userinfo = match authority.rsplit_once('@') {
    Some((user, _)) => format!("{user}@"),
    None => String::new(),
  };
  format!("{scheme}://{userinfo}localhost:5432{tail}")
}

/// Porta da URL (quando explícita).
pub fn url_port(url: &str) -> Option<u16> {
  let rest = url.split_once("://").map(|(_, r)| r)?;
  let authority = match rest.find(['/', '?']) {
    Some(i) => &rest[..i],
    None => rest,
  };
  let host_port = match authority.rsplit_once('@') {
    Some((_, hp)) => hp,
    None => authority,
  };
  let port = host_port.rsplit_once(':')?;
  if port.1.is_empty() || !port.1.chars().all(|c| c.is_ascii_digit()) {
    return None;
  }
  port.1.parse::<u16>().ok()
}

/// Um container de Postgres candidato (label do compose `service=postgres`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresCandidate {
  /// Nome do container.
  pub name: String,
  /// Portas publicadas no host (string crua do `docker ps`, ex.:
  /// `0.0.0.0:5432->5432/tcp`).
  pub published_ports: String,
}

/// Containeres de Postgres rodando (label do compose `service=postgres`).
///
/// `PDV_POSTGRES_CONTAINER` fixa o container (quando há mais de um stack
/// rodando na máquina e o primeiro não é o certo).
pub fn find_postgres_candidates() -> Vec<PostgresCandidate> {
  if let Ok(name) = std::env::var("PDV_POSTGRES_CONTAINER") {
    if !name.trim().is_empty() {
      return vec![PostgresCandidate {
        name: name.trim().to_string(),
        published_ports: String::new(),
      }];
    }
  }
  let args = [
    "ps",
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--format",
    "{{.Names}}|{{.Ports}}",
  ];
  let (code, out) = capture_cmd_in_dir(&root_path(), &[], "docker", &args);
  if code != 0 {
    return Vec::new();
  }
  out
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty())
    .map(|l| match l.split_once('|') {
      Some((name, ports)) => PostgresCandidate {
        name: name.to_string(),
        published_ports: ports.to_string(),
      },
      None => PostgresCandidate {
        name: l.to_string(),
        published_ports: String::new(),
      },
    })
    .collect()
}

/// Escolhe o container do Postgres entre os candidatos.
///
/// Com **mais de um** stack de Postgres na máquina (dev + produção, por
/// exemplo) não dá para escolher no chute: o `docker ps` não garante ordem e
/// o CLI poderia falar com o banco **errado** — que, em produção, significa
/// ler/escrever o banco de outro ambiente. A desambiguação é pela **porta
/// publicada** (a `DATABASE_URL` local tem a porta do host); se ainda sobrar
/// ambiguidade, o CLI para e pede `PDV_POSTGRES_CONTAINER`.
pub fn pick_postgres_container(
  candidates: &[PostgresCandidate],
  url_port: Option<u16>,
) -> Result<Option<String>, String> {
  match candidates.len() {
    0 => Ok(None),
    1 => Ok(Some(candidates[0].name.clone())),
    _ => {
      if let Some(port) = url_port {
        let matching: Vec<&PostgresCandidate> = candidates
          .iter()
          .filter(|c| c.published_ports.contains(&format!(":{port}->")))
          .collect();
        if matching.len() == 1 {
          return Ok(Some(matching[0].name.clone()));
        }
      }
      let nomes: Vec<&str> = candidates.iter().map(|c| c.name.as_str()).collect();
      Err(format!(
        "há {} containers de Postgres do PDV neste host ({}) e não dá para saber qual é o \
         do DATABASE_URL.\nDefina PDV_POSTGRES_CONTAINER=<container> (ou deixe só um stack \
         rodando).",
        candidates.len(),
        nomes.join(", ")
      ))
    }
  }
}

/// Decide a estratégia de acesso ao banco.
///
/// * `psql` no host → [`DbTarget::Host`] (sempre tem prioridade).
/// * Sem `psql`, URL local e container de Postgres rodando →
///   [`DbTarget::Container`].
/// * Sem `psql` e URL remota → erro: o fallback de container não vale para
///   uma URL que aponta para outro banco.
/// * Sem `psql`, URL local e sem container → erro explicando as duas saídas.
pub fn choose_target(
  psql_present: bool,
  url_host: &str,
  container: Option<String>,
) -> Result<DbTarget, String> {
  if psql_present {
    return Ok(DbTarget::Host);
  }
  if !is_local_host(url_host) {
    return Err(format!(
      "o cliente `psql` não está instalado neste host e o DATABASE_URL aponta para \
       '{url_host}' (banco remoto): o fallback para container do Postgres não se aplica \
       a uma URL remota.\n\
       Instale o cliente do Postgres no host (ex.: `sudo apt install postgresql-client`) \
       ou rode a CLI na máquina do banco."
    ));
  }
  match container {
    Some(c) => Ok(DbTarget::Container(c)),
    None => Err(
      "não encontrei o cliente `psql` no host nem um container de Postgres rodando.\n\
       Faça uma das duas coisas:\n\
         (a) subir o ambiente em containers — `pdv setup` (o host só precisa do Docker); ou\n\
         (b) instalar o cliente do Postgres no host — `sudo apt install postgresql-client`."
        .to_string(),
    ),
  }
}

/// Resolve a `DATABASE_URL` e a estratégia de acesso ao banco.
pub fn resolve_db_target() -> Result<(String, DbTarget), String> {
  let url = load_db_url();
  if url.trim().is_empty() {
    return Err("DATABASE_URL não definido (backend/.env ausente?)".into());
  }
  let host = url_host(&url).unwrap_or_default();
  let psql_present = which::which("psql").is_ok();
  let container = if psql_present {
    None
  } else {
    let candidates = find_postgres_candidates();
    pick_postgres_container(&candidates, url_port(&url))?
  };
  let target = choose_target(psql_present, &host, container)?;
  Ok((url, target))
}

/// Roda um `psql` com saída em colunas `|` e retorna o stdout.
///
/// No caminho host é o `psql` do `PATH`; no caminho container é
/// `docker exec <container> psql …` (mesmos argumentos, banco equivalente).
pub fn psql(sql: &str, tuples_only: bool) -> Result<String, String> {
  psql_for_tenant(sql, tuples_only, None)
}

/// O mesmo `psql`, mas com o **contexto de tenant** da sessão.
///
/// A policy de RLS (migration `0015_rls_policies.sql`) compara a linha com
/// `current_setting('app.tenant_id')` — sem esse contexto, a sessão não vê
/// NENHUMA linha da loja (a policy filtra tudo). Por isso a CLI, que fala com
/// o banco por fora do app, precisa declarar de qual loja ela está falando.
///
/// O `SET` vai no MESMO comando do `psql` (uma sessão só) e é do tipo
/// `SET` (sessão), não `SET LOCAL`: o `psql -c` pode mandar várias
/// instruções, e o contexto precisa valer para todas.
pub fn psql_for_tenant(
  sql: &str,
  tuples_only: bool,
  tenant_id: Option<&str>,
) -> Result<String, String> {
  let (url, target) = resolve_db_target()?;
  let comando = match tenant_id {
    Some(id) if !id.trim().is_empty() => {
      format!(
        "SET app.tenant_id = '{}'; {}",
        id.replace(char::from(39), "''"),
        sql
      )
    }
    _ => sql.to_string(),
  };
  let mut args: Vec<String> = Vec::new();
  match &target {
    DbTarget::Host => {
      args.push(url.clone());
      args.push("-v".into());
      args.push("ON_ERROR_STOP=1".into());
      if tuples_only {
        args.push("-t".into());
        args.push("-A".into());
        args.push("-F".into());
        args.push("|".into());
      }
      args.push("-c".into());
      args.push(comando.clone());
      let args: Vec<&str> = args.iter().map(String::as_str).collect();
      let (code, out) = capture_cmd_in_dir(&backend_dir(), &[], "psql", &args);
      if code != 0 {
        return Err(format!("psql falhou ({}):\n{}", target.label(), out.trim()));
      }
      Ok(out)
    }
    DbTarget::Container(name) => {
      let url = rewrite_url_for_container(&url);
      args.push("exec".into());
      args.push(name.clone());
      args.push("psql".into());
      args.push(url);
      args.push("-v".into());
      args.push("ON_ERROR_STOP=1".into());
      if tuples_only {
        args.push("-t".into());
        args.push("-A".into());
        args.push("-F".into());
        args.push("|".into());
      }
      args.push("-c".into());
      args.push(comando.clone());
      let args: Vec<&str> = args.iter().map(String::as_str).collect();
      let (code, out) = capture_cmd_in_dir(&root_path(), &[], "docker", &args);
      if code != 0 {
        return Err(format!("psql falhou ({}):\n{}", target.label(), out.trim()));
      }
      Ok(out)
    }
  }
}

/// Exporta o DADO de uma loja para um arquivo SQL (um `COPY` por tabela,
/// filtrado pelo `tenant_id`).
///
/// O `pg_dump --schema` (o dump por loja do modelo antigo) morreu com o RLS:
/// o `pg_dump` não respeita a policy, então despejaria o banco INTEIRO no
/// arquivo de uma loja. O export por tenant é a alternativa honesta: o
/// `COPY` roda DENTRO da sessão com o `app.tenant_id`, então a policy filtra
/// as linhas de verdade — o arquivo tem só a loja.
pub fn export_tenant_to_file(tenant_id: &str, output_file: &str) -> Result<(), String> {
  let tabelas = tabelas_com_tenant_id()?;
  if tabelas.is_empty() {
    return Err("nenhuma tabela de loja encontrada (o banco tem as migrations aplicadas?)".to_string());
  }
  let id = tenant_id.replace(char::from(39), "''");
  let mut script = String::new();
  for t in &tabelas {
    script.push_str(&format!(
      "\\echo === tabela {t} ===\nCOPY (SELECT * FROM {t} WHERE tenant_id = '{id}') TO STDOUT WITH (FORMAT csv, HEADER true);\n"
    ));
  }
  let out = psql_for_tenant(&script, false, Some(tenant_id))?;
  std::fs::write(output_file, out).map_err(|e| format!("não consegui escrever {output_file}: {e}"))
}

/// As tabelas que têm a coluna `tenant_id` — as de loja (o modelo por linha).
fn tabelas_com_tenant_id() -> Result<Vec<String>, String> {
  let query = "SELECT c.relname FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relkind = 'r' \
                   AND EXISTS (SELECT 1 FROM pg_attribute a \
                                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id') \
                 ORDER BY c.relname";
  let out = psql(query, true)?;
  Ok(out
    .lines()
    .map(|l| l.trim())
    .filter(|l| !l.is_empty())
    .map(|l| l.to_string())
    .collect())
}



#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn psql_no_host_vence_a_regra() {
    let t = choose_target(true, "localhost", Some("pdv-dev-postgres-1".into())).unwrap();
    assert_eq!(t, DbTarget::Host);
  }

  #[test]
  fn url_local_sem_psql_usa_container() {
    let t = choose_target(false, "localhost", Some("pdv-dev-postgres-1".into())).unwrap();
    assert_eq!(t, DbTarget::Container("pdv-dev-postgres-1".into()));
  }

  #[test]
  fn url_local_sem_psql_e_sem_container_falha() {
    let err = choose_target(false, "127.0.0.1", None).unwrap_err();
    assert!(
      err.contains("postgresql-client"),
      "mensagem deveria orientar a instalação: {err}"
    );
    assert!(
      err.contains("pdv setup"),
      "mensagem deveria citar o setup em containers: {err}"
    );
  }

  #[test]
  fn url_remota_nunca_usa_container() {
    let err =
      choose_target(false, "db.exemplo.com", Some("pdv-dev-postgres-1".into())).unwrap_err();
    assert!(
      err.contains("remoto"),
      "mensagem deveria explicar a URL remota: {err}"
    );
    assert!(
      err.contains("postgresql-client"),
      "mensagem deveria orientar a instalação: {err}"
    );
  }

  #[test]
  fn extrai_host_da_url() {
    assert_eq!(
      url_host("postgres://pdv:pdv@localhost:5432/pdv").as_deref(),
      Some("localhost")
    );
    assert_eq!(
      url_host("postgres://pdv:pdv@127.0.0.1:5432/pdv").as_deref(),
      Some("127.0.0.1")
    );
    assert_eq!(
      url_host("postgres://pdv:pdv@db.exemplo.com:5432/pdv").as_deref(),
      Some("db.exemplo.com")
    );
    assert_eq!(
      url_host("postgres://pdv:pdv@postgres/pdv").as_deref(),
      Some("postgres")
    );
    assert_eq!(
      url_host("postgres://pdv:pdv@localhost/pdv").as_deref(),
      Some("localhost")
    );
    assert_eq!(url_host("nao-e-url"), None);
  }

  #[test]
  fn reescreve_url_para_o_container() {
    assert_eq!(
      rewrite_url_for_container("postgres://pdv:pdv_password@localhost:5432/pdv"),
      "postgres://pdv:pdv_password@localhost:5432/pdv"
    );
    // Porta publicada no host é outra; dentro do container é sempre 5432.
    assert_eq!(
      rewrite_url_for_container("postgres://pdv:pdv_password@localhost:55432/pdv"),
      "postgres://pdv:pdv_password@localhost:5432/pdv"
    );
    // Query string preservada.
    assert_eq!(
      rewrite_url_for_container("postgres://pdv:x@localhost/pdv?sslmode=disable"),
      "postgres://pdv:x@localhost:5432/pdv?sslmode=disable"
    );
  }

  #[test]
  fn hosts_locais_sao_reconhecidos() {
    assert!(is_local_host("localhost"));
    assert!(is_local_host("127.0.0.1"));
    assert!(!is_local_host("db.exemplo.com"));
    assert!(!is_local_host("postgres"));
  }

  #[test]
  fn le_o_env_de_dev() {
    let content =
      "# comentario\nPOSTGRES_USER=pdv\nDEV_POSTGRES_PORT=5433\n\nPOSTGRES_PASSWORD=pdv_password\n";
    assert_eq!(
      dev_env_value_in(content, "POSTGRES_USER").as_deref(),
      Some("pdv")
    );
    assert_eq!(
      dev_env_value_in(content, "DEV_POSTGRES_PORT").as_deref(),
      Some("5433")
    );
    assert_eq!(dev_env_value_in(content, "POSTGRES_DB"), None);
    assert_eq!(dev_env_value_in(content, "# comentario"), None);
  }

  #[test]
  fn extrai_porta_da_url() {
    assert_eq!(
      url_port("postgres://pdv:pdv@localhost:5432/pdv"),
      Some(5432)
    );
    assert_eq!(url_port("postgres://pdv:pdv@localhost/pdv"), None);
    assert_eq!(url_port("nao-e-url"), None);
  }

  #[test]
  fn sem_candidato_nao_ha_container() {
    assert_eq!(pick_postgres_container(&[], Some(5432)).unwrap(), None);
  }

  #[test]
  fn candidato_unico_e_o_container() {
    let cands = vec![PostgresCandidate {
      name: "pdv-dev-postgres-1".into(),
      published_ports: "0.0.0.0:5432->5432/tcp".into(),
    }];
    assert_eq!(
      pick_postgres_container(&cands, Some(5432)).unwrap(),
      Some("pdv-dev-postgres-1".to_string())
    );
  }

  #[test]
  fn varios_candidatos_desambiguam_pela_porta_publicada() {
    let cands = vec![
      PostgresCandidate {
        name: "pdv-dev-postgres-1".into(),
        published_ports: "0.0.0.0:5433->5432/tcp".into(),
      },
      PostgresCandidate {
        name: "deploy-postgres-1".into(),
        published_ports: "0.0.0.0:5432->5432/tcp".into(),
      },
    ];
    assert_eq!(
      pick_postgres_container(&cands, Some(5432)).unwrap(),
      Some("deploy-postgres-1".to_string())
    );
  }

  #[test]
  fn varios_candidatos_sem_porta_que_casa_parar() {
    let cands = vec![
      PostgresCandidate {
        name: "pdv-dev-postgres-1".into(),
        published_ports: "0.0.0.0:5433->5432/tcp".into(),
      },
      PostgresCandidate {
        name: "deploy-postgres-1".into(),
        published_ports: "0.0.0.0:5432->5432/tcp".into(),
      },
    ];
    let err = pick_postgres_container(&cands, None).unwrap_err();
    assert!(
      err.contains("PDV_POSTGRES_CONTAINER"),
      "a ambiguidade precisa apontar o escape-hatch: {err}"
    );
    assert!(
      err.contains("pdv-dev-postgres-1") && err.contains("deploy-postgres-1"),
      "o erro precisa listar os candidatos: {err}"
    );
  }
}
