use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ============================================================
// Config do aplicativo (por instalação)
//
// O app desktop serve dois planos: backend LOCAL (mesma máquina, plano
// local) ou backend REMOTO (nuvem). O mesmo instalador atende os dois — o
// que muda é este arquivo.
//
//Onde ele mora, e por quê:
//   %APPDATA%\PDV\app.json      (usuário)  — escrito pelo app, sem admin
//   %ProgramData%\PDV\app.json  (máquina) — opcional; o instalador cria a
//     pasta mas não o arquivo, então quem grava hoje é o app, sempre no
//     caminho do usuário. Decisão em aberto em docs/11 §9.3.
//
// Ordem de leitura: usuário primeiro, depois máquina. Assim o gerente
// consegue corrigir a URL sem pedir reinstalação, e o padrão do
// instalador continua valendo para os outros usuários da máquina.
//
// NENHUM desses caminhos fica dentro do diretório de instalação de propósito:
// o auto-update substitui os arquivos do app, então config dentro do
// diretório seria sobrescrita a cada atualização.
// ============================================================

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
  /// "local" (backend na própria máquina) ou "cloud" (backend remoto).
  pub mode: String,
  /// Origem do backend, sem barra final: `https://app.exemplo.com.br` ou
  /// `http://127.0.0.1:3000`. Vazio = ainda não configurado.
  #[serde(default)]
  pub api_base: Option<String>,
  /// Daemon de impressão local (HTTP em loopback).
  #[serde(default)]
  pub daemon_url: Option<String>,
}

fn machine_config_path() -> Option<PathBuf> {
  if cfg!(windows) {
    std::env::var_os("ProgramData")
      .map(|dir| PathBuf::from(dir).join("PDV").join("app.json"))
  } else {
    None
  }
}

fn user_config_path() -> Option<PathBuf> {
  if cfg!(windows) {
    std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("PDV").join("app.json"))
  } else {
    std::env::var_os("XDG_CONFIG_HOME")
      .map(PathBuf::from)
      .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
      .map(|dir| dir.join("PDV").join("app.json"))
  }
}

fn read_config(path: &Option<PathBuf>) -> Option<AppConfig> {
  let path = path.as_ref()?;
  let raw = fs::read_to_string(path).ok()?;
  match serde_json::from_str::<AppConfig>(&raw) {
    Ok(config) => Some(config),
    Err(err) => {
      // Arquivo corrompido não pode derrubar o boot: o app abre sem config
      // e a tela de setup reaparece.
      log::warn!("app.json inválido em {}: {err}", path.display());
      None
    }
  }
}

/// Lê a config do app. `None` = nunca configurado (primeiro boot).
#[tauri::command]
fn app_config() -> Option<AppConfig> {
  read_config(&user_config_path()).or_else(|| read_config(&machine_config_path()))
}

/// Grava a config no caminho do usuário (não exige admin). Só o app grava
/// aqui. O padrão de máquina é opcional e fica em %ProgramData% (§9.3 do
/// docs/11).
#[tauri::command]
fn save_app_config(config: AppConfig) -> Result<AppConfig, String> {
  let path =
    user_config_path().ok_or_else(|| "Não foi possível localizar o diretório de configuração.".to_string())?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Falha ao criar {}: {e}", parent.display()))?;
  }
  let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
  fs::write(&path, raw).map_err(|e| format!("Falha ao gravar {}: {e}", path.display()))?;
  Ok(config)
}

/// Apaga a config do usuário e volta ao padrão da instalação.
#[tauri::command]
fn reset_app_config() -> Result<(), String> {
  let path =
    user_config_path().ok_or_else(|| "Não foi possível localizar o diretório de configuração.".to_string())?;
  match fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(format!("Falha ao remover {}: {err}", path.display())),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_process::init())
    // Update automático: o JS (`entities/updater`) chama `check`/`downloadAndInstall`
    // e decide o que fazer com o resultado. Aqui só registramos o plugin — a
    // chave pública vem do tauri.conf.json e o manifesto é validado no Rust.
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![app_config, save_app_config, reset_app_config])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
