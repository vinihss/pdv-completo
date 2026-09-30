//! Canal de status: o que o **aparelho** diz, combinado com o que o **driver**
//! publishou.
//!
//! Regra da composição (`compose`): o socket tem precedência sobre o spooler
//! para papel/tampa/iktus, porque lê a impressora; o spooler entra como
//! complemento e como único sinal quando a impressora é USB.
//!
//! Regra do gate (`ready`): só `true` com dispositivo presente e **nenhum**
//! bloqueio conhecido. Um campo `unknown` não bloqueia sozinho — não há
//! evidência de falha — mas desliga `can_report_paper`, e é isso que a tela
//! mostra ao operador.
//!
//! `Transport` e `PrinterProfile` vêm do `pdv-shared` (ver `super::mod`), e é
//! por isso que a interpretação dos bits do spooler continua aqui, e não no
//! `spooler`: este arquivo roda — e é testado — no Linux de desenvolvimento,
//! onde o `spooler` nem compila.

use std::collections::BTreeMap;

use super::{now_ms, socket_address, PrintHealth, PrinterProfile, Transport};

/// Flags de `PRINTER_INFO_2W.Status` (`winnt.h`).
///
/// Definidas aqui, e não no `spooler`, porque o `status` precisa interpretá-las
/// em qualquer plataforma — o `spooler` é `#[cfg(windows)]`, e o gate roda no
/// Linux de desenvolvimento. Os valores foram conferidos na fonte do crate
/// `windows` 0.62 (`Win32::Graphics::Printing`), não de memória: número errado
/// aqui bloqueia operação legítima.
pub mod spooler_flags {
  pub const PAUSED: u32 = 1;
  pub const ERROR: u32 = 2;
  pub const PAPER_JAM: u32 = 8;
  pub const PAPER_OUT: u32 = 16;
  pub const MANUAL_FEED: u32 = 32;
  pub const PAPER_PROBLEM: u32 = 64;
  pub const OFFLINE: u32 = 128;
  pub const NOT_AVAILABLE: u32 = 4096;
  pub const NO_TONER: u32 = 262_144;
  pub const TONER_LOW: u32 = 131_072;
  pub const DOOR_OPEN: u32 = 4_194_304;
  pub const USER_INTERVENTION: u32 = 1_048_576;
}

/// Resposta do `DLE EOT`, já interpretada.
#[derive(Debug, Clone, Default)]
pub struct SensorStatus {
  /// O socket respondeu? `false` = impressora USB, IP errado ou aparelho
  /// desligado — e as três coisas precisam de mensagens diferentes.
  pub reachable: bool,
  /// `ok` | `near_end` | `out` | `unknown`
  pub paper: String,
  pub cover_open: bool,
  pub cutter_error: bool,
  pub offline: bool,
  pub error: bool,
  pub raw: BTreeMap<String, u8>,
  pub message: Option<String>,
}

impl SensorStatus {
  /// Sem canal com o aparelho. `pub` porque os testes de composição do gate
  /// (em `commands.rs`) precisam montar exatamente esse cenário.
  pub fn unknown(message: impl Into<String>) -> Self {
    SensorStatus {
      reachable: false,
      paper: "unknown".into(),
      message: Some(message.into()),
      ..Default::default()
    }
  }

  /// O aparelho disse algo sobre a bobina? Só vale se respondeu.
  fn has_paper_reading(&self) -> bool {
    self.reachable && self.paper != "unknown"
  }
}

/// Pergunta o aparelho nos 4 sub status do ESC/POS.
///
/// O mapa de bits é o Epson/Bematech mais comum — o mesmo do
/// `applyStatusBits` do Go (`main.go:577-596`), e o mesmo aviso: a variante e
/// o firmware da MP-4200 precisam de bancada. Por isso `raw` volta sempre:
/// ajustar a interpretação não perde o diagnóstico.
pub fn probe_socket(socket: Option<&str>) -> SensorStatus {
  let Some(address) = socket.map(str::trim).filter(|s| !s.is_empty()) else {
    return SensorStatus::unknown(
      "impressora sem IP configurado: é USB, então o sensor de bobina não está disponível",
    );
  };

  // Um erro de rede já é a resposta: aparelho desligado, IP errado, porta
  // bloqueada. Não vale retry aqui — quem chama é o gate, e o operador está
  // olhando.
  let mut status = SensorStatus {
    reachable: true,
    paper: "unknown".into(),
    ..Default::default()
  };
  let mut falha: Option<String> = None;

  for n in 1..=4u8 {
    match super::transport::query_dle_eot(address, n) {
      Ok(value) => {
        status.raw.insert(n.to_string(), value);
        match n {
          1 => {
            status.offline = value & 0x08 != 0;
            status.error |= value & 0x20 != 0;
          }
          2 => status.cover_open = value & 0x04 != 0,
          3 => {
            status.cutter_error = value & 0x04 != 0;
            status.error |= value & 0x08 != 0;
          }
          _ => {
            status.paper = if value & 0x60 != 0 {
              "out".to_string()
            } else if value & 0x0c != 0 {
              "near_end".to_string()
            } else {
              "ok".to_string()
            };
          }
        }
      }
      Err(err) => {
        // Perdeu a conexão no meio: os sub status lidos até aí continuam
        // válidos, mas o conjunto fica incompleto.
        status.reachable = false;
        falha = Some(err);
        break;
      }
    }
  }

  if !status.reachable {
    status.message = Some(match falha {
      Some(err) => format!("DLE EOT em {address} falhou: {err}"),
      None => format!("sem resposta do DLE EOT em {address}"),
    });
  }
  status
}

/// O que o driver do Windows/publicou, normalizado. `raw` é o
/// `PRINTER_INFO_2W.Status` cru, e a interpretação fica aqui — não no
/// `spooler`, que é `#[cfg(windows)]` e não é testável no Linux de
/// desenvolvimento. É este arranjo que deixa o gate testável.
#[derive(Debug, Clone, Default)]
pub struct SpoolerStatus {
  pub found: bool,
  pub port: String,
  pub raw: u32,
}

impl SpoolerStatus {
  fn has(&self, bit: u32) -> bool {
    self.raw & bit != 0
  }

  /// O driver está dizendo que falta papel? Só usado como fallback, quando não
  /// há socket. `PAPER_JAM` entra junto: papel preso é "não imprimiu" do mesmo
  /// jeito que acabou, e o operador precisa saber qual dos dois.
  fn says_paper_out(&self) -> bool {
    use spooler_flags::{PAPER_JAM, PAPER_OUT, PAPER_PROBLEM};
    self.has(PAPER_OUT) || self.has(PAPER_PROBLEM) || self.has(PAPER_JAM)
  }

  /// Impossível imprimir por este canal. `NOT_AVAILABLE` entra com
  /// `OFFLINE`: nos dois casos o Windows diz que nada vai sair, e a diferença
  /// é um código de erro que o operador não vai saber decifrar.
  fn is_offline(&self) -> bool {
    use spooler_flags::{NOT_AVAILABLE, OFFLINE};
    self.has(OFFLINE) || self.has(NOT_AVAILABLE)
  }

  /// Erro que a MS não explica. `USER_INTERVENTION` e `DOOR_OPEN` contam como
  /// erro porque exigem alguém na frente da impressora.
  fn is_error(&self) -> bool {
    use spooler_flags::{DOOR_OPEN, ERROR, NO_TONER, USER_INTERVENTION};
    self.has(ERROR) || self.has(USER_INTERVENTION) || self.has(DOOR_OPEN) || self.has(NO_TONER)
  }

  fn is_cover_open(&self) -> bool {
    self.has(spooler_flags::DOOR_OPEN)
  }
}

/// Junta as duas fontes num `PrintHealth`.
pub fn compose(
  destination: &str,
  profile: &PrinterProfile,
  sensor: SensorStatus,
  spooler: SpoolerStatus,
) -> PrintHealth {
  let target = match profile.transport {
    Transport::Spooler => profile.printer_name.clone().unwrap_or_default(),
    Transport::Tcp => profile.socket.clone().unwrap_or_default(),
  };

  // Precedência: o aparelho, se respondeu. Senão o driver. Senão ninguém.
  let (paper, paper_source) = if sensor.has_paper_reading() {
    (sensor.paper.clone(), "socket")
  } else if spooler.says_paper_out() {
    ("out".to_string(), "spooler")
  } else if profile.transport == Transport::Spooler && spooler.found {
    ("unknown".to_string(), "spooler")
  } else {
    ("unknown".to_string(), "unknown")
  };

  // `can_report_paper` é o que a tela usa para dizer "a bobina é sua". É true
  // quando existe canal direto com o aparelho, ou quando o driver foi visto
  // marcando falta de papel pelo menos uma vez. A calibração definitiva
  // (com e sem bobina) é da fase 0, em bancada — não dá para provar por
  // inferência em cima de um snapshot.
  let can_report_paper = sensor.has_paper_reading() || spooler.says_paper_out();

  let mut messages: Vec<String> = Vec::new();
  if !target.is_empty() {
    if profile.transport == Transport::Spooler && !spooler.found {
      messages.push(format!("a fila \"{target}\" não existe nesta máquina"));
    }
  } else {
    messages.push("nenhuma impressora configurada para este destino".to_string());
  }
  if let Some(msg) = &sensor.message {
    messages.push(msg.clone());
  }
  if !can_report_paper {
    messages.push(
      "esta impressora não reporta falta de papel: o bloqueio vale para offline e erro".to_string(),
    );
  }

  let offline = sensor.offline || spooler.is_offline();
  let error = sensor.error || spooler.is_error();
  let cover_open = sensor.cover_open || spooler.is_cover_open();
  let paper_blocks = paper == "out";

  let ready = !target.is_empty()
    && !spooler_is_absent(profile, &spooler)
    && !offline
    && !error
    && !cover_open
    && !paper_blocks;

  PrintHealth {
    destination: destination.to_string(),
    ready,
    transport: profile.transport.as_str().to_string(),
    target,
    printer_found: spooler.found || sensor.reachable,
    paper,
    paper_source: paper_source.to_string(),
    cover_open,
    cutter_error: sensor.cutter_error,
    offline,
    error,
    can_report_paper,
    raw: sensor.raw,
    message: if messages.is_empty() { None } else { Some(messages.join("; ")) },
    checked_at_ms: now_ms(),
  }
}

fn spooler_is_absent(profile: &PrinterProfile, spooler: &SpoolerStatus) -> bool {
  match profile.transport {
    // Só o spooler exige que a fila exista.
    Transport::Spooler => !spooler.found,
    // Impressão por TCP: a fila não é consultada; o que vale é o aparelho ter
    // endereço configurado.
    Transport::Tcp => socket_address(profile).is_none(),
  }
}
