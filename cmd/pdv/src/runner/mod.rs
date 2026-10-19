use std::path::Path;
use std::process::Command;

use crate::config::root_path;

/// Executa um comando herdando o terminal (usado pelos subcomandos da CLI).
pub fn run_cmd_in_dir(dir: &Path, cmd: &str, args: &[&str]) -> i32 {
  let mut c = Command::new(cmd);
  c.current_dir(dir);
  c.args(args);
  c.stdin(std::process::Stdio::inherit());
  c.stdout(std::process::Stdio::inherit());
  c.stderr(std::process::Stdio::inherit());
  let status = match c.status() {
    Ok(s) => s,
    Err(e) => {
      eprintln!("erro ao executar {}: {}", cmd, e);
      return 1;
    }
  };
  status.code().unwrap_or(1)
}

/// Executa o comando capturando stdout+stderr (sem herdar o terminal).
/// Devolve `(código_de_saída, saída_combinada)`.
pub fn capture_cmd_in_dir(
  dir: &Path,
  envs: &[(&str, &str)],
  cmd: &str,
  args: &[&str],
) -> (i32, String) {
  let mut c = Command::new(cmd);
  c.current_dir(dir);
  c.args(args);
  for (k, v) in envs {
    c.env(k, v);
  }
  match c.output() {
    Ok(o) => {
      let mut s = String::from_utf8_lossy(&o.stdout).to_string();
      let err = String::from_utf8_lossy(&o.stderr);
      if !err.is_empty() {
        if !s.is_empty() && !s.ends_with('\n') {
          s.push('\n');
        }
        s.push_str(&err);
      }
      (o.status.code().unwrap_or(1), s)
    }
    Err(e) => (1, format!("erro ao executar {cmd}: {e}")),
  }
}

/// Igual a `npm_run`, mas capturando a saída em vez de herdar o terminal.
pub fn capture_npm_run(rel_dir: &str, script: &str, extra: &[&str]) -> (i32, String) {
  let root = root_path();
  let dir = root.join(rel_dir);
  let mut args = vec!["run", script];
  if !extra.is_empty() {
    args.push("--");
    args.extend_from_slice(extra);
  }
  capture_cmd_in_dir(&dir, &[], "npm", &args)
}

pub fn npm_run(rel_dir: &str, script: &str, extra: &[&str]) -> i32 {
  let root = root_path();
  let dir = root.join(rel_dir);
  let mut args = vec!["run", script];
  if !extra.is_empty() {
    args.push("--");
    args.extend_from_slice(extra);
  }
  run_cmd_in_dir(&dir, "npm", &args)
}

pub fn exec_script(script_rel: &str, args: &[&str]) -> i32 {
  let root = root_path();
  let script_path = root.join(script_rel);
  let script_str = script_path.to_string_lossy().to_string();
  let mut all_args = vec![script_str.as_str()];
  all_args.extend_from_slice(args);
  run_cmd_in_dir(&root, "bash", &all_args)
}
