use crate::config::root_path;
use crate::runner::{exec_script, npm_run};
use clap::{Parser, Subcommand};
use std::process::Command;

#[derive(Parser)]
#[command(name = "pdv", about = "PDV CLI (Rust)", version)]
pub struct Cli {
  #[command(subcommand)]
  pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
  Status,
  Tui,
  /// Sobe o ambiente de dev INTEIRO em containers Docker (docker compose:
  /// postgres, redis, backend, frontend e caddy), roda o seed de demonstração
  /// e imprime as URLs do ambiente. O host só precisa do Docker.
  Setup {
    #[arg(long)]
    no_seed: bool,
  },
  Dev {
    target: String,
    #[arg(long)]
    profile: Option<String>,
  },
  Build {
    target: String,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    rest: Vec<String>,
  },
  Test {
    target: Option<String>,
  },
  Lint {
    target: Option<String>,
  },
  Db {
    #[command(subcommand)]
    cmd: DbSub,
  },
  Worktree {
    #[command(subcommand)]
    cmd: WorktreeSub,
  },
  Deploy {
    #[command(subcommand)]
    cmd: DeploySub,
  },
  Check {
    target: Option<String>,
  },
}

#[derive(Subcommand)]
pub enum DbSub {
  Migrate,
  MigrateRegistry,
  Generate,
  /// Lista os seeds disponíveis (catálogo lido do manifest do backend)
  Seeds,
  /// Aplica um seed pelo id (veja `pdv db seeds`)
  Seed {
    /// Id do seed (ex.: base, demo, prod). Sem id, só lista os disponíveis.
    id: Option<String>,
  },
  /// [DEPRECIADO] use `pdv db seed prod`
  SeedProd,
  DeactivateDemo,
  Provision {
    slug: String,
    display_name: Option<String>,
  },
  ResetPin {
    slug: String,
    pin: Option<String>,
  },
  AddUser {
    slug: String,
    name: String,
    /// waiter|kitchen|manager|cashier|courier
    profile: String,
    pin: Option<String>,
  },
  List,
}

#[derive(Subcommand)]
pub enum WorktreeSub {
  New { branch: String },
  List,
  Rm { branch: String },
}

#[derive(Subcommand)]
pub enum DeploySub {
  Switch {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Backup {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  BackupFetch {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Probe {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Install {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Reset {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Caddy {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  RunCloud {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
  Pedido {
    #[arg(trailing_var_arg = true)]
    rest: Vec<String>,
  },
}

pub fn handle(cli: Cli) -> i32 {
  match cli.command {
    None => {
      print_usage();
      0
    }
    Some(Commands::Tui) => {
      crate::tui::run_tui();
      0
    }
    Some(Commands::Status) => handle_status(),
    Some(Commands::Setup { no_seed }) => {
      let mut args = vec![];
      if no_seed {
        args.push("--no-seed");
      }
      exec_script("scripts/dev/setup-dev.sh", &args)
    }
    Some(Commands::Dev { target, profile }) => handle_dev(&target, profile.as_deref()),
    Some(Commands::Build { target, rest }) => handle_build(&target, &rest),
    Some(Commands::Test { target }) => handle_test(target.as_deref()),
    Some(Commands::Lint { target }) => handle_lint(target.as_deref()),
    Some(Commands::Db { cmd }) => handle_db(cmd),
    Some(Commands::Worktree { cmd }) => handle_worktree(cmd),
    Some(Commands::Deploy { cmd }) => handle_deploy(cmd),
    Some(Commands::Check { target }) => handle_check(target.as_deref()),
  }
}

fn print_usage() {
  print!("{}", USAGE);
}

const USAGE: &str = "Uso: ./pdv <domínio> <comando> [args...]\n\nDomínios:\n  status\n  setup [--no-seed]  (ambiente de dev em containers)\n  worktree <new|list|rm>\n  dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]\n  build <standalone|app|backend|frontend>\n  test <backend|frontend|gateway|all>\n  lint <frontend|all>\n  db <migrate|migrate-registry|generate|seeds|seed <id>|seed-prod|deactivate-demo|provision|reset-pin|add-user|list>\n  tui\n  check [backend|frontend|all]\n  deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]\n  -h|--help\n\nSem argumentos, ./pdv imprime esta ajuda e sai com 0.\nCada domínio com argumento inválido imprime o uso e sai com != 0.\n\n`pdv db seeds` lista os seeds do catálogo (manifest do backend) e\n`pdv db seed <id>` aplica um deles. `pdv db seed` sem id só lista.\n";

fn handle_status() -> i32 {
  use crate::config::root_path;
  println!("── git ──");
  let root = root_path();
  let _ = Command::new("git")
    .args(["-C", root.to_str().unwrap_or("."), "rev-parse", "--git-dir"])
    .status();
  println!();
  println!("── worktrees ──");
  let _ = exec_script("scripts/dev/dev-worktree.sh", &["list"]);
  println!();
  println!("── versões ──");
  for tool in ["git", "node", "npm", "go", "docker"] {
    if let Ok(path) = which::which(tool) {
      if !path.as_os_str().is_empty() {
        let (cmd, args) = if tool == "go" {
          ("go", vec!["version"])
        } else {
          (tool, vec!["--version"])
        };
        let out = Command::new(cmd).args(&args).output();
        let ver = out
          .map(|o| {
            String::from_utf8_lossy(&o.stdout)
              .split('\n')
              .next()
              .unwrap_or("?")
              .to_string()
          })
          .unwrap_or_else(|_| "?".to_string());
        println!("  {:<6} {}", tool, ver);
      } else {
        println!("  {:<6} não instalado", tool);
      }
    } else {
      println!("  {:<6} não instalado", tool);
    }
  }
  println!();
  println!("── dependências locais ──");
  for dep in [
    "backend/node_modules",
    "frontend/node_modules",
    "backend/.env",
  ] {
    let p = root.join(dep);
    if p.exists() {
      println!("  {:<22} ok", dep);
    } else {
      println!("  {:<22} AUSENTE", dep);
    }
  }
  0
}

fn handle_dev(target: &str, profile: Option<&str>) -> i32 {
  match target {
    "backend" => {
      if profile.is_some() {
        crate::ui::die("--profile não se aplica a './pdv dev backend'");
      }
      npm_run("backend", "dev", &[])
    }
    "frontend" => {
      if let Some(p) = profile {
        match p {
          "pdv" | "kds" | "garcon" | "entregador" => {
            npm_run("frontend", &format!("dev:{}", p), &[])
          }
          _ => crate::ui::die(&format!(
            "perfil inválido: {} (esperado: pdv|kds|garcon|entregador)",
            p
          )),
        }
      } else {
        npm_run("frontend", "dev", &[])
      }
    }
    "all" => {
      if let Some(p) = profile {
        match p {
          "pdv" | "kds" | "garcon" | "entregador" => {}
          _ => crate::ui::die(&format!(
            "perfil inválido: {} (esperado: pdv|kds|garcon|entregador)",
            p
          )),
        }
      }
      let root = root_path();
      let backend_dir = root.join("backend");
      let mut backend = std::process::Command::new("npm");
      backend.args(["run", "dev"]);
      backend.current_dir(&backend_dir);
      backend.stdout(std::process::Stdio::inherit());
      backend.stderr(std::process::Stdio::inherit());
      if let Err(_) = backend.spawn() {
        return 1;
      }
      let code = match profile {
        Some(p) => npm_run("frontend", &format!("dev:{}", p), &[]),
        None => npm_run("frontend", "dev", &[]),
      };
      code
    }
    _ => crate::ui::die(
      "uso: ./pdv dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]",
    ),
  }
}

fn handle_build(target: &str, rest: &[String]) -> i32 {
  let rest_refs: Vec<&str> = rest.iter().map(|s| s.as_str()).collect();
  match target {
    "standalone" => exec_script("scripts/build/build-app.sh", &rest_refs),
    "app" => exec_script("scripts/build/build-app.sh", &rest_refs),
    "backend" => npm_run("backend", "build", &[]),
    "frontend" => npm_run("frontend", "build", &[]),
    _ => crate::ui::die("uso: ./pdv build <standalone|app|backend|frontend> [opções]"),
  }
}

fn handle_test(target: Option<&str>) -> i32 {
  match target.unwrap_or("all") {
    "backend" => npm_run("backend", "test", &[]),
    "frontend" => npm_run("frontend", "test", &[]),
    "gateway" => exec_script("scripts/test/test-gateway.sh", &[]),
    "all" => {
      let code = npm_run("backend", "test", &[]);
      if code != 0 {
        return code;
      }
      let code = npm_run("frontend", "test", &[]);
      if code != 0 {
        return code;
      }
      exec_script("scripts/test/test-gateway.sh", &[])
    }
    _ => crate::ui::die("uso: ./pdv test <backend|frontend|gateway|all>"),
  }
}

fn handle_lint(target: Option<&str>) -> i32 {
  match target.unwrap_or("all") {
    "frontend" => npm_run("frontend", "lint", &[]),
    "all" => {
      let code = npm_run("frontend", "lint", &[]);
      if code != 0 {
        return code;
      }
      exec_script("scripts/test/gofmt-gate.sh", &["ws-gateway"])
    }
    _ => crate::ui::die("uso: ./pdv lint <frontend|all>"),
  }
}

/// Roda um script `tsx` do backend (`backend/src/infra/db/<script>`), herdando o
/// terminal, com `backend/.env` carregado e as env vars informadas.
fn run_tsx_script(script: &str, envs: &[(&str, &str)], args: &[&str]) -> i32 {
  let backend_dir = root_path().join("backend");
  let _ = dotenvy::from_path(backend_dir.join(".env"));
  let mut c = std::process::Command::new("npx");
  c.args(["--yes", "tsx", &format!("src/infra/db/{script}")]);
  c.args(args);
  c.current_dir(&backend_dir);
  for (k, v) in envs {
    c.env(k, v);
  }
  // A URL do banco: `backend/.env` é gitignored e pode não existir (no
  // ambiente de dev, tudo é container e o host não tem esse arquivo). A
  // resolução do `ops::db` cai no `deploy/.env.dev` — sem exportar isso, o
  // script aborta com "DATABASE_URL é obrigatório".
  let db_url = crate::ops::load_db_url();
  if !db_url.trim().is_empty() {
    c.env("DATABASE_URL", &db_url);
  }
  let s = c.status().unwrap_or_else(|_| std::process::exit(1));
  s.code().unwrap_or(1)
}

fn handle_db(cmd: DbSub) -> i32 {
  match cmd {
    DbSub::Migrate => npm_run("backend", "db:migrate", &[]),
    DbSub::MigrateRegistry => npm_run("backend", "db:migrate:registry", &[]),
    DbSub::Generate => npm_run("backend", "db:generate", &[]),
    DbSub::Seeds => handle_db_seeds(),
    DbSub::Seed { id } => match id {
      Some(id) => handle_db_seed(&id),
      // Sem id: NÃO aplica o seed base "por conta própria" — lista e mostra o uso.
      None => {
        handle_db_seeds();
        println!();
        println!("uso: pdv db seed <id>   (ids em `pdv db seeds`)");
        1
      }
    },
    DbSub::SeedProd => {
      eprintln!("aviso: `pdv db seed-prod` está depreciado — use `pdv db seed prod`.");
      handle_db_seed("prod")
    }
    DbSub::DeactivateDemo => npm_run("backend", "db:deactivate-demo", &[]),
    DbSub::Provision { slug, display_name } => {
      let dn = display_name.as_deref().unwrap_or(&slug);
      run_tsx_script(
        "provision-tenant.ts",
        &[("SLUG", &slug), ("DISPLAY_NAME", dn)],
        &[&slug, dn],
      )
    }
    DbSub::ResetPin { slug, pin } => {
      let pin_val = pin.as_deref().unwrap_or("");
      run_tsx_script(
        "reset-manager-pin.ts",
        &[("SLUG", &slug), ("PIN", pin_val)],
        &[&slug, pin_val],
      )
    }
    DbSub::AddUser {
      slug,
      name,
      profile,
      pin,
    } => {
      let pin_val = pin.as_deref().unwrap_or("");
      run_tsx_script(
        "add-user.ts",
        &[
          ("SLUG", &slug),
          ("USER_NAME", &name),
          ("USER_PROFILE", &profile),
          ("USER_PIN", pin_val),
        ],
        &[&slug, &name, &profile, pin_val],
      )
    }
    DbSub::List => handle_db_list(),
  }
}

/// Lista os tenants do registry — a MESMA implementação que a TUI usa
/// (`ops::list_tenants`), para que os dois mostrem exatamente o mesmo
/// (inclusive o tenant implícito do ambiente single-tenant).
fn handle_db_list() -> i32 {
  match crate::ops::list_tenants() {
    Ok(tenants) => {
      if tenants.is_empty() {
        println!("Nenhum tenant encontrado no registry.");
        return 0;
      }
      println!("Tenants (registry public.tenant):");
      println!("{}", "-".repeat(72));
      for t in &tenants {
        let mut linha = format!(
          "{:<20} {:<22} {:<18} {}",
          t.slug, t.schema_name, t.display_name, t.status
        );
        if !t.custom_domain.is_empty() {
          linha.push_str(&format!("  ({})", t.custom_domain));
        }
        println!("{}", linha);
      }
      println!("{}", "-".repeat(72));
      println!("Total: {} tenant(s)", tenants.len());
      0
    }
    Err(e) => crate::ui::die(&e),
  }
}

/// Lista o catálogo de seeds — lido do manifest do backend em runtime
/// (adicionar um seed novo não exige recompilar a CLI).
fn handle_db_seeds() -> i32 {
  match crate::ops::list_seeds() {
    Ok(seeds) => {
      println!("Seeds disponíveis (manifest do backend):");
      for s in seeds {
        println!();
        println!("  {} — {}", s.id, s.title);
        println!("     {}", s.description);
        println!(
          "     npm: {} | destrutivo: {} | seguro em produção: {} | exige PostGIS: {}",
          s.npm_script,
          yes_no(s.destructive),
          yes_no(s.production_safe),
          yes_no(s.requires_postgis)
        );
      }
      println!();
      println!("Aplique com: pdv db seed <id>");
      0
    }
    Err(e) => crate::ui::die(&e),
  }
}

/// Aplica um seed pelo id (catálogo do manifest do backend).
fn handle_db_seed(id: &str) -> i32 {
  match crate::ops::apply_seed(id) {
    Ok(out) => {
      if !out.trim().is_empty() {
        println!("{}", out.trim_end());
      }
      0
    }
    Err(e) => crate::ui::die(&e),
  }
}

fn yes_no(b: bool) -> &'static str {
  if b {
    "sim"
  } else {
    "não"
  }
}

fn handle_worktree(cmd: WorktreeSub) -> i32 {
  match cmd {
    WorktreeSub::New { branch } => exec_script("scripts/dev/dev-worktree.sh", &["new", &branch]),
    WorktreeSub::List => exec_script("scripts/dev/dev-worktree.sh", &["list"]),
    WorktreeSub::Rm { branch } => exec_script("scripts/dev/dev-worktree.sh", &["rm", &branch]),
  }
}

fn handle_deploy(cmd: DeploySub) -> i32 {
  match cmd {
    DeploySub::Switch { rest } => exec_script(
      "deploy/switch.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Backup { rest } => exec_script(
      "deploy/backup.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::BackupFetch { rest } => exec_script(
      "deploy/backup-fetch.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Probe { rest } => exec_script(
      "deploy/probe-availability.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Install { rest } => exec_script(
      "deploy/install.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Reset { rest } => exec_script(
      "deploy/reset.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Caddy { rest } => exec_script(
      "deploy/caddy-assemble.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::RunCloud { rest } => exec_script(
      "deploy/run-cloud.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
    DeploySub::Pedido { rest } => exec_script(
      "deploy/deploy-pedido-public.sh",
      &rest.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    ),
  }
}

fn handle_check(target: Option<&str>) -> i32 {
  match target.unwrap_or("all") {
    "backend" => {
      let code = npm_run("backend", "build", &[]);
      if code != 0 {
        return code;
      }
      npm_run("backend", "test", &[])
    }
    "frontend" => {
      let code = npm_run("frontend", "lint", &[]);
      if code != 0 {
        return code;
      }
      let code = npm_run("frontend", "build", &[]);
      if code != 0 {
        return code;
      }
      npm_run("frontend", "test", &[])
    }
    "all" => {
      let code = handle_check(Some("backend"));
      if code != 0 {
        return code;
      }
      handle_check(Some("frontend"))
    }
    _ => crate::ui::die("uso: ./pdv check [backend|frontend|all]"),
  }
}
