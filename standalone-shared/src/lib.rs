//! Núcleo compartilhado dos 4 apps standalone (PDV, KDS, Garçom, Entregador).
//!
//! O que mora aqui é o que é **igual nos quatro**:
//!
//! - [`config`] — o `app.json` por instalação (backend local ou nuvem) e os
//!   commands que o JS chama para ler/gravar/apagar essa config.
//! - [`printing`] — **só o esquema** de impressoras (o que vai dentro do
//!   `app.json`). A implementação de impressão (spooler do Windows, ESC/POS,
//!   sondagem de status) é do app de caixa e fica no `standalone-pdv`; ela
//!   consome estes tipos e devolve o `PrintHealth` que a UI consome.
//! - [`plugins`] — o registro comum de plugins do `tauri::Builder`, com flags
//!   para cada app desligar o que não faz sentido na sua plataforma.
//!
//! O que **não** mora aqui: ciclo de vida da janela, commands de domínio de
//! cada app, `tauri.conf.json`, `build.rs`, capabilities. Cada app é dono do seu.
//!
//! ## Como um app usa isto
//!
//! ```rust,ignore
//! use tauri::Runtime;
//!
//! pub fn run<R: Runtime>() {
//!   pdv_shared::builder(tauri::Builder::default())
//!     .invoke_handler(tauri::generate_handler![
//!       // os 3 commands de config, compartilhados — mesma assinatura nos 4 apps
//!       pdv_shared::app_config,
//!       pdv_shared::save_app_config,
//!       pdv_shared::reset_app_config,
//!       // ...e os commands do app, que vivem no crate dele
//!     ])
//!     .run(tauri::generate_context!())
//!     .expect("error while running tauri application");
//! }
//! ```
//!
//! `builder` é genérico sobre `R: Runtime` de propósito: dois dos quatro apps
//! (Garçom e Entregador) rodam em Android/iOS, onde o runtime não é `Wry`.

#![deny(missing_docs)]

pub mod config;
pub mod plugins;
pub mod printing;

pub use config::{app_config, reset_app_config, save_app_config, AppConfig};
pub use plugins::{builder, Plugins};
pub use printing::{PrinterProfile, PrintersConfig, Transport};