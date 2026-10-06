//! Impressão térmica direta no app (fase 1).
//!
//! A divisão de papéis que o resto do app assume:
//!
//! - [`escpos`] monta os bytes. Puro, sem I/O, e testável no Linux — é o que o
//!   golden test compara com o renderizador Go.
//! - [`spooler`] é o **transporte de impressão** no Windows (spooler, como o
//!   Gestor do iFood).
//! - [`status`] é o **canal de status**, deliberadamente separado do
//!   transporte: `DLE EOT` por socket quando a impressora tem IP, e as flags do
//!   spooler como complemento.
//!
//! Por que separar: o status que interessa — tem bobina? a tampa está fechada? —
//! é do **aparelho**, e o spooler só publica o que o **driver** achou bom
//! publicar, de uma cópia local possivelmente velha. A sondagem `DLE EOT` fala
//! com a impressora. Confundir os dois (que é o que o daemon Go fazia, com
//! `status` atrelado ao perfil TCP) é o que faz o gate bloquear por engano ou
//! deixar passar sem papel.
//!
//! `PrintHealth` carrega **procedência** de cada campo (`paper_source`) e o
//! que a impressora é capaz de reportar. A UI diz o que sabe; quando não sabe,
//! mostra que não sabe, em vez de inventar um "pronto".
//!
//! ## O que foi portado e o que foi importado
//!
//! Este módulo é o porte de `frontend/src-tauri/src/printing/`, com uma única
//! mudança estrutural: `Transport`, `PrinterProfile` e `PrintersConfig` — o
//! **esquema persistido** no `app.json` — NÃO são redefinidos aqui. Eles vêm do
//! `pdv_shared` (crate `standalone-shared`) e são re-exportados abaixo, porque o
//! `standalone-kds` vai ler o mesmo `app.json` e as duas implementações do mesmo
//! esquema divergindo em silêncio é o modo como o `app.json` de uma loja deixa
//! de abrir. Redefinir aqui daria exatamente esse problema.
//!
//! O que fica neste crate é o que o shared explicitamente não traz: quem envia o
//! ticket para a fila, quem pergunta o status do aparelho e o `PrintHealth` que
//! a UI consome.

pub mod codepage;
pub mod commands;
pub mod escpos;
pub mod status;
pub mod transport;

#[cfg(windows)]
pub mod spooler;

use serde::Serialize;

/// O esquema de impressoras é do `pdv-shared` (o `app.json` é um arquivo só e
/// os 4 apps leem o mesmo). Re-exportado para que os módulos daqui — e o resto
/// do app — falem em `super::Transport` como no app v1.
pub use pdv_shared::{PrinterProfile, PrintersConfig, Transport};

/// Endereço útil da impressora (`host:porta`), ou `None`.
///
/// O `pdv-shared` tem um `socket_address()` equivalente, mas **privado**: lá
/// ele só precisava do filtro dentro do próprio `is_unconfigured()`. Aqui a
/// composição do gate precisa do mesmo filtro (`printing/status.rs`), e o que
/// conta como "não configurado" precisa ser o mesmo nos dois lugares — se um
/// aceitasse `"  "` (só espaços) e o outro não, a tela diria que há impressora
/// onde a config diz que não há. Se um dia o shared expor esse helper com
/// `pub`, este `fn` some e os dois pontos passam a usar o de lá.
pub(crate) fn socket_address(profile: &PrinterProfile) -> Option<&str> {
  profile.socket.as_deref().filter(|s| !s.trim().is_empty())
}

/// Uma fila de impressão do Windows, como o sistema a lista.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
  pub name: String,
  pub port: String,
  pub driver: String,
  pub location: String,
  /// `Status` cru do `PRINTER_INFO_2W`, em hex. Vai junto porque a fase 0
  /// (bancada) precisa registrar os valores **daquele** driver para calibrar o
  /// gate, e adivinhar aqui não dá.
  pub raw_status: u32,
  pub is_default: bool,
}

/// O que o app sabe sobre a impressora agora.
///
/// `ready` é a única coisa que o gate consulta, e ele é conservador: só é
/// `true` com o dispositivo presente e sem nenhum bloqueio conhecido. Campos
/// com `unknown` não bloqueiam sozinhos — o operador é avisado no texto.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintHealth {
  pub destination: String,
  pub ready: bool,
  pub transport: String,
  /// Fila configurada (spooler) ou `host:porta` (tcp).
  pub target: String,
  pub printer_found: bool,
  /// `ok` | `near_end` | `out` | `unknown`
  pub paper: String,
  /// `socket` = DLE EOT (leitura do aparelho) · `spooler` = flag do driver ·
  /// `unknown` = ninguém sabe.
  pub paper_source: String,
  pub cover_open: bool,
  pub cutter_error: bool,
  pub offline: bool,
  pub error: bool,
  /// `true` quando **esta** impressora é capaz de dizer que está sem papel.
  /// `false` = impressora USB, ou driver que nunca seta PAPER_OUT: o gate ainda
  /// bloqueia por offline/erro, mas a tela precisa dizer que a bobina é
  /// responsabilidade do operador.
  pub can_report_paper: bool,
  /// Bytes crus do `DLE EOT` (`1`,`2`,`3`,`4` → valor). Devolvidos sempre,
  /// mesmo interpretados, para ajustar o mapa sem perder o diagnóstico.
  pub raw: std::collections::BTreeMap<String, u8>,
  pub message: Option<String>,
  /// Epoch em ms. O formatação é do lado do JS de propósito.
  pub checked_at_ms: i64,
}

impl PrintHealth {
  pub fn unknown(destination: &str, message: impl Into<String>) -> Self {
    PrintHealth {
      destination: destination.to_string(),
      ready: false,
      transport: String::new(),
      target: String::new(),
      printer_found: false,
      paper: "unknown".into(),
      paper_source: "unknown".into(),
      cover_open: false,
      cutter_error: false,
      offline: false,
      error: false,
      can_report_paper: false,
      raw: Default::default(),
      message: Some(message.into()),
      checked_at_ms: now_ms(),
    }
  }
}

pub fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}
