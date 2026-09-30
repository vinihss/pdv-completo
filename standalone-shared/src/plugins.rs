//! Registro comum de plugins do `tauri::Builder`.
//!
//! Os 4 apps registram o mesmo conjunto de plugins no boot, com duas
//! exceções: os apps mobile (Garçom e Entregador) não querem `process`
//! (não existe reinstalar/reabrir o binário da loja) nem `log` em arquivo
//! (grava log em disco a cada chamada, o que é ruído em celular e consome
//! armazenamento). `Plugins` existe para que cada app desligue o que não for
//! usar sem duplicar a cadeia de `.plugin(...)`.
//!
//! ## Por que `http` é sempre ligado
//!
//! O app roda na origem `tauri.localhost`, e o backend libera CORS só para o
//! domínio configurado — se a chamada saísse por `fetch` no webview, o
//! navegador do app bloquearia. O plugin `tauri-plugin-http` ignora CORS, e é
//! por ele que o JS conversa com a API nos 4 apps.
//!
//! ## Por que `updater` e `process` andam juntos
//!
//! `updater` baixa e instala a versão nova; `process` é quem dá o
//! `app.restart()` logo depois. Instalar sem reiniciar deixa o usuário com a
//! versão antiga até fechar o app; por isso os dois flags saem juntos.

use tauri::{Builder, Runtime};

/// Quais plugins comuns registrar. `true` = registra.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plugins {
  /// `tauri-plugin-updater`: update automático no boot.
  ///
  /// Sem este plugin o `checkForUpdate()` do JS sempre falha e o app abre na
  /// versão em disco (aceitável em loja offline, mas sem update). A chave
  /// pública fica em `tauri.conf.json`; a privada em `TAURI_SIGNING_PRIVATE_KEY`.
  pub updater: bool,
  /// `tauri-plugin-process`: `app.restart()` / `app.relaunch()` depois que o
  /// updater instala.
  pub process: bool,
  /// `tauri-plugin-log` em build debug. Em release fica desligado.
  ///
  /// Ligar em release grava log em disco a cada chamada; em mobile isso é
  /// ruído e consumo de armazenamento, então os apps mobile deixam `false`.
  pub log: bool,
}

impl Default for Plugins {
  /// Todos ligados — o preset do app desktop (PDV/KDS).
  fn default() -> Self {
    Plugins { updater: true, process: true, log: true }
  }
}

impl Plugins {
  /// Aplica a seleção de plugins ao builder dado.
  ///
  /// O `http` entra sempre (ver doc do módulo). O `log` entra só em debug
  /// (`debug_assertions`), mesmo com `log: true` — assim o preset desktop se
  /// comporta igual ao app v1.
  pub fn apply<R: Runtime>(self, builder: Builder<R>) -> Builder<R> {
    let Plugins { updater, process, log } = self;

    let builder = builder.plugin(tauri_plugin_http::init::<R>());

    // `process` antes de `updater`: o `process` é o que reinicia o app
    // depois que o updater instala a versão nova.
    let builder = if process {
      builder.plugin(tauri_plugin_process::init::<R>())
    } else {
      builder
    };

    let builder = if updater {
      // Update automático: o JS (`entities/updater`) chama `check`/`downloadAndInstall`
      // e decide o que fazer com o resultado. Aqui só registramos o plugin — a
      // chave pública vem do tauri.conf.json e o manifesto é validado no Rust.
      builder.plugin(tauri_plugin_updater::Builder::new().build::<R>())
    } else {
      builder
    };

    builder.setup(move |app| {
      if log && cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build::<R>(),
        )?;
      }
      Ok(())
    })
  }
}

/// Atalho para o preset padrão ([`Plugins::default`], tudo ligado).
///
/// Cada app chama isso no seu `run()` e segue registrando os commands
/// próprios. Exemplo para o PDV:
///
/// ```rust,ignore
/// pub fn run() {
///   pdv_shared::builder(tauri::Builder::default())
///     .invoke_handler(tauri::generate_handler![
///       pdv_shared::app_config,
///       pdv_shared::save_app_config,
///       pdv_shared::reset_app_config,
///       crate::printing::commands::printer_list,
///     ])
///     .run(tauri::generate_context!())
///     .expect("error while running tauri application");
/// }
/// ```
///
/// Para um app mobile, que não quer `process` nem log em arquivo:
///
/// ```rust,ignore
/// use tauri::Runtime;
///
/// pub fn run<R: Runtime>() {
///   let plugins = pdv_shared::Plugins { updater: true, process: false, log: false };
///   plugins
///     .apply(tauri::Builder::default())
///     .run(tauri::generate_context!())
///     .expect("error while running tauri application");
/// }
/// ```
pub fn builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
  Plugins::default().apply(builder)
}