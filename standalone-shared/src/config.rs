//! Config do aplicativo (por instalação).
//!
//! Portado de `frontend/src-tauri/src/lib.rs` — as assinaturas dos commands são
//! as mesmas de lá, e precisam continuar sendo: o JS já chama `app_config`,
//! `save_app_config` e `reset_app_config` nos 4 apps.
//!
//! A diferença em relação ao app v1 é que o `printers` não é mais um detalhe do
//! caixa: o esquema mora aqui (em [`crate::printing`]) porque o `app.json` é um
//! arquivo só, e o `standalone-kds` vai ler o mesmo arquivo. O que ainda é do
//! caixa — mandar o ticket para a fila — fica no `standalone-pdv`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ============================================================
// Config do aplicativo (por instalação)
//
// O app serve dois planos: backend LOCAL (mesma máquina, plano
// local) ou backend REMOTO (nuvem). O mesmo instalador atende os dois — o
// que muda é este arquivo.
//
// Onde ele mora, e por quê:
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
//
// No Linux/macOS (dev) o usuário é `$XDG_CONFIG_HOME/PDV/app.json`, ou
// `$HOME/.config/PDV/app.json` quando o XDG não está setado; máquina não
// existe fora do Windows e `read_config(None)` devolve `None`, o mesmo
// resultado de um arquivo ausente.
// ============================================================

/// O `app.json`. Serializado em `camelCase` porque é o que o JS envia e
/// recebe.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
  /// "local" (backend na própria máquina) ou "cloud" (backend remoto).
  pub mode: String,
  /// Origem do backend, sem barra final: `https://app.exemplo.com.br` ou
  /// `http://127.0.0.1:3000`. Vazio = ainda não configurado.
  #[serde(default)]
  pub api_base: Option<String>,
  /// Impressoras por destino. Mora aqui — e não no backend — porque a
  /// impressora é fato da **máquina**: a mesma loja pode ter a cozinha numa
  /// estação e o caixa em outra, e cada uma tem a sua fila e o seu IP.
  ///
  /// `default` no serde para que um `app.json` escrito antes da impressão
  /// continue valendo: a loja não pode ficar sem app config por causa de um
  /// campo novo.
  #[serde(default)]
  pub printers: crate::printing::PrintersConfig,
}

/// Caminho de máquina (`%ProgramData%\PDV\app.json`). Só Windows.
fn machine_config_path() -> Option<PathBuf> {
  if cfg!(windows) {
    std::env::var_os("ProgramData").map(|dir| PathBuf::from(dir).join("PDV").join("app.json"))
  } else {
    None
  }
}

/// Caminho de usuário (`%APPDATA%\PDV\app.json` no Windows,
/// `$XDG_CONFIG_HOME/PDV/app.json` ou `~/.config/PDV/app.json` no resto).
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

/// Lê e desserializa um caminho. `None` quando o arquivo não existe **ou**
/// quando está corrompido — nos dois casos o app segue sem config.
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
///
/// Command público do `tauri::generate_handler!` de qualquer um dos 4 apps.
#[tauri::command]
pub fn app_config() -> Option<AppConfig> {
  read_config(&user_config_path()).or_else(|| read_config(&machine_config_path()))
}

/// Grava a config no caminho do usuário (não exige admin). Só o app grava
/// aqui. O padrão de máquina é opcional e fica em %ProgramData% (§9.3 do
/// docs/11).
#[tauri::command]
pub fn save_app_config(config: AppConfig) -> Result<AppConfig, String> {
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
pub fn reset_app_config() -> Result<(), String> {
  let path =
    user_config_path().ok_or_else(|| "Não foi possível localizar o diretório de configuração.".to_string())?;
  match fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(format!("Falha ao remover {}: {err}", path.display())),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::printing::Transport;

  /// Arquivo temporário só de teste. O caminho vem do `read_config`, que não
  /// depende de env var, então o teste não corre para o `app.json` real.
  fn temp_path(nome: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pdv-shared-teste-{}-{nome}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("app.json"))
  }

  /// Contrato que protege a loja: um `app.json` escrito antes de existir o
  /// campo `printers` precisa continuar abrindo o app, com as impressoras
  /// vazias. Sem o `#[serde(default)]` no campo, isto vira erro de parse e a
  /// loja perde a config inteira.
  #[test]
  fn app_json_sem_printers_ainda_valida() {
    let config: AppConfig =
      serde_json::from_str(r#"{"mode":"cloud","apiBase":"https://app.exemplo.com.br"}"#).unwrap();
    assert_eq!(config.mode, "cloud");
    assert_eq!(config.api_base.as_deref(), Some("https://app.exemplo.com.br"));
    assert!(config.printers.is_empty());
  }

  /// O inverso do teste acima: um `app.json` novo não pode quebrar um cliente
  /// velho que ainda manda só `mode`.
  #[test]
  fn app_json_com_printers_le_como_os_campos_conhecidos() {
    let raw = r#"{"mode":"local","printers":{"kitchen":{"transport":"tcp","socket":"192.168.0.50:9100"}}}"#;
    let config: AppConfig = serde_json::from_str(raw).unwrap();
    let profile = config.printers.profile("kitchen").unwrap();
    assert_eq!(profile.transport, Transport::Tcp);
    assert_eq!(profile.socket.as_deref(), Some("192.168.0.50:9100"));
    // Destino não configurado continua vazio, e não quebra o deserialize.
    assert!(config.printers.profile("courier").unwrap().socket.is_none());
    assert!(!config.printers.is_empty());
  }

  /// Config corrompido não derruba o boot: devolve `None` e segue.
  #[test]
  fn app_json_corrompido_devolve_none_em_vez_de_panicar() {
    let path = temp_path("corrompido").unwrap();
    std::fs::write(&path, "{ isso não é json").unwrap();
    assert!(read_config(&Some(path)).is_none());
  }

  /// Arquivo ausente também é `None` — é o caso do primeiro boot.
  #[test]
  fn app_json_ausente_devolve_none() {
    let path = temp_path("ausente").unwrap();
    let _ = std::fs::remove_file(&path);
    assert!(read_config(&Some(path)).is_none());
    // Caminho indefinido (fora do Windows, sem env var) também.
    assert!(read_config(&None).is_none());
  }

  /// Ordem de leitura: usuário primeiro, depois máquina. É o que permite ao
  /// gerente corrigir a URL sem reinstalar, e é a ordem que
  /// [`app_config`] implementa.
  #[test]
  fn usuario_tem_precedencia_sobre_maquina() {
    let user = temp_path("usuario").unwrap();
    let machine = temp_path("maquina").unwrap();
    std::fs::write(&user, r#"{"mode":"cloud"}"#).unwrap();
    std::fs::write(&machine, r#"{"mode":"local"}"#).unwrap();

    let escolhido =
      read_config(&Some(user.clone())).or_else(|| read_config(&Some(machine.clone())));
    assert_eq!(escolhido.unwrap().mode, "cloud");

    // Sem config do usuário, o padrão da instalação assume.
    let _ = std::fs::remove_file(&user);
    let escolhido =
      read_config(&Some(user.clone())).or_else(|| read_config(&Some(machine.clone())));
    assert_eq!(escolhido.unwrap().mode, "local");
  }
}