//! Tipos de impressão compartilhados entre os apps.
//!
//! O contrato que vive no `app.json` é o mesmo para os quatro apps: os quatro
//! precisam saber **se existe uma impressora configurada** para cada destino
//! (para não tentar imprimir coisas para um destino vazio e bloquear a operação
//! no app de caixa, ou simplesmente para esconder/validar). A implementação —
//! enviar bytes ao spooler ou por TCP — fica no `standalone-pdv`. O
//! `standalone-shared` expõe só os tipos e helpers necessários para ler essa
//! configuração, com `serde` compatível com o `app.json` já escrito pelo app v1.
//!
//! Portado de `frontend/src-tauri/src/printing/mod.rs` (parcial): removemos os
//! structs que dependem de `status`/I/O (`PrintHealth`, `PrinterInfo`, etc.) e
//! mantemos **somente** o esquema persistido. Essa escolha evita trazer código
//! específico do Windows ou de rede para o shared, enquanto mantém exatos os
//! nomes de campos e `rename_all = "camelCase"`.
//!
//! Comentários foram preservados sempre que explicam a decisão (persistência
//! da config fora do diretório de instalação, e o fato da impressora ser da
//! máquina).

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
  /// Impressão via spooler do Windows (fila do sistema). Padrão.
  Spooler,
  /// Impressão direta por TCP (`host:porta`, geralmente 9100).
  Tcp,
}

impl Default for Transport {
  fn default() -> Self {
    Transport::Spooler
  }
}

impl Transport {
  /// Representação em `lowercase` usada em serialização/JSON (coincide com o
  /// que o app v1 já grava).
  #[inline]
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
  /// Transporte escolhido para este destino.
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

  /// `true` quando este destino **não tem nenhuma impressora configurada**.
  #[inline]
  pub fn is_unconfigured(&self) -> bool {
    self.printer_name.is_none() && self.socket_address().is_none()
  }
}

/// Impressoras por destino (`kitchen`, `courier`, `fiscal`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrintersConfig {
  /// Impressora da cozinha (tickets de preparo).
  pub kitchen: PrinterProfile,
  /// Impressora de entregas (courier).
  pub courier: PrinterProfile,
  /// Impressora fiscal (quando usada).
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

  /// `true` quando **nenhuma** impressora foi configurada — o app usa isso
  /// para não tentar imprimir (e não bloquear o operador) em instalação nova.
  #[inline]
  pub fn is_empty(&self) -> bool {
    self.kitchen.is_unconfigured()
      && self.courier.is_unconfigured()
      && self.fiscal.is_unconfigured()
  }
}