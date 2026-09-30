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

pub mod commands;
pub mod escpos;
pub mod status;
pub mod transport;

#[cfg(windows)]
pub mod spooler;

use serde::{Deserialize, Serialize};

/// Como o ticket chega na impressora.
///
/// `spooler` é o padrão: USB funciona sem a loja saber o IP da impressora, e
/// é o caminho que o iFood usa. `tcp` existe porque (a) se o driver reformatar
/// o ESC/POS em vez de passar os bytes crus, o spooler não serve — e trocar o
/// transporte não pode exigir mexer no renderizador.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
  Spooler,
  Tcp,
}

impl Default for Transport {
  fn default() -> Self {
    Transport::Spooler
  }
}

impl Transport {
  pub fn as_str(self) -> &'static str {
    match self {
      Transport::Spooler => "spooler",
      Transport::Tcp => "tcp",
    }
  }
}

/// Config de **uma** impressora, por destino. Vive no `AppConfig` que o app já
/// usa (`%ProgramData%\PDV\app.json` para a máquina, `%APPDATA%` para o
/// usuário) — a impressora é fato da máquina, então é onde essa config mora.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrinterProfile {
  pub transport: Transport,
  /// Fila do Windows (`GetPrinter`/EnumPrinters), ex.: `MP-4200 (USB001)`.
  /// Necessário no transporte `spooler`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub printer_name: Option<String>,
  /// `host:porta` da impressora, ex.: `192.168.0.50:9100`. Necessário no
  /// transporte `tcp` e para a sondagem de status. Ausente = USB: a impressora
  /// não expõe sensor de bobina, e o app diz isso na tela em vez de fingir.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub socket: Option<String>,
  /// Id do template. Na fase 1 o template vem no payload (a nuvem é a fonte);
  /// este campo existe para a fase 2, em que ele passa a ser uma chave só.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub template_id: Option<String>,
}

impl PrinterProfile {
  fn socket_address(&self) -> Option<&str> {
    self.socket.as_deref().filter(|s| !s.trim().is_empty())
  }
}

/// Impressoras por destino (`kitchen`, `courier`, `fiscal`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrintersConfig {
  pub kitchen: PrinterProfile,
  pub courier: PrinterProfile,
  pub fiscal: PrinterProfile,
}

impl PrintersConfig {
  /// Perfil do destino. Destino desconhecido é erro explícito: imprimir o
  /// cupom de cozinha no destino errado é pior do que não imprimir nada.
  pub fn profile(&self, destination: &str) -> Result<&PrinterProfile, String> {
    match destination {
      "kitchen" => Ok(&self.kitchen),
      "courier" => Ok(&self.courier),
      "fiscal" => Ok(&self.fiscal),
      other => Err(format!("destino de impressão desconhecido: {other}")),
    }
  }

  /// `true` quando nenhuma impressora foi configurada — o app usa isso para
  /// não tentar imprimir (e não bloquear o operador) em instalação nova.
  pub fn is_empty(&self) -> bool {
    [self.kitchen.is_unconfigured(), self.courier.is_unconfigured(), self.fiscal.is_unconfigured()]
      .iter()
      .all(|v| *v)
  }
}

impl PrinterProfile {
  fn is_unconfigured(&self) -> bool {
    self.printer_name.is_none() && self.socket_address().is_none()
  }
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
