//! Commands de impressão. É a superfície que o JS chama (`invoke`).
//!
//! Todos devolvem `Result<T, String>` com mensagem em PT-BR: o texto vai para
//! o modal de gate, então tem que ser lido por quem está no balcão, não por
//! log de desenvolvimento.
//!
//! ## O que mudou em relação ao app v1
//!
//! A config vem do `pdv-shared` (`pdv_shared::app_config`/`AppConfig`) em vez
//! da cópia local do `frontend/src-tauri/src/lib.rs` — o `app.json` é o mesmo
//! arquivo para todos os apps da família, e a impressora é fato da máquina. Os
//! `Transport`/`PrinterProfile`/`PrintersConfig` também vêm de lá
//! (`super::{PrinterProfile, Transport}` são re-exports do shared).

use serde::{Deserialize, Serialize};

use super::escpos::{render, Block, Order, Template};
use super::status::{self, SpoolerStatus};
use super::{now_ms, PrintHealth, PrinterInfo, PrinterProfile, Transport};
use pdv_shared::AppConfig;

/// Lista as filas de impressão que o Windows enxerga.
#[tauri::command]
pub fn printer_list() -> Result<Vec<PrinterInfo>, String> {
  #[cfg(windows)]
  {
    super::spooler::list_printers()
  }
  #[cfg(not(windows))]
  {
    Err("listar impressoras só funciona no app Windows.".to_string())
  }
}

/// Estado da impressora de um destino, já composto (aparelho + driver).
///
/// É este command que o gate consulta. `ready` é conservador de propósito: sem
/// evidência de problema, `true`; com qualquer bloqueio conhecido, `false`.
#[tauri::command]
pub fn printer_status(destination: String) -> Result<PrintHealth, String> {
  let config = pdv_shared::app_config().unwrap_or_default();
  let printers = config.printers;
  let profile = printers.profile(&destination)?;
  Ok(check(profile, &destination))
}

/// Consulta um perfil sem passar pela config — o mesmo caminho de `printer_status`,
/// separado para os testes de composição do gate.
fn check(profile: &PrinterProfile, destination: &str) -> PrintHealth {
  let sensor = status::probe_socket(profile.socket.as_deref());

  #[cfg(windows)]
  let spooler = match profile.printer_name.as_deref() {
    Some(name) => super::spooler::status(name).unwrap_or_else(|err| {
      // Fila inacessível não é motivo para mentir "pronto": segue como
      // `found: false`, e a composição vira não-pronto com a mensagem do erro.
      log::warn!("status da fila: {err}");
      SpoolerStatus::default()
    }),
    None => SpoolerStatus::default(),
  };

  #[cfg(not(windows))]
  let spooler = SpoolerStatus {
    found: false,
    port: String::new(),
    raw: 0,
  };

  status::compose(destination, profile, sensor, spooler)
}

/// Ticket de teste, para a fase 0 (bancada) e para o botão "imprimir teste".
///
/// ASCII **de propósito**: a validação do spooler é sobre corte, alinhamento e
/// largura de 48 colunas. Botar acento aqui misturaria o teste de transporte
/// com o teste de charset, e um erro de charset pareceria falha de driver.
#[tauri::command]
pub fn printer_test(destination: String) -> Result<PrintTestResult, String> {
  let columns = 48;
  let template = Template {
    id: "test".into(),
    version: 1,
    destination: destination.clone(),
    columns,
    blocks: vec![
      Block {
        r#type: "text".into(),
        value: "PDV - TESTE DE IMPRESSORA".into(),
        align: "center".into(),
        bold: true,
        size: "double".into(),
        lines: 0,
      },
      Block {
        r#type: "text".into(),
        value: format!("destino: {destination}"),
        align: "center".into(),
        ..Default::default()
      },
      Block { r#type: "separator".into(), ..Default::default() },
      Block {
        r#type: "text".into(),
        value: "ESQUERDA".into(),
        align: "left".into(),
        bold: true,
        ..Default::default()
      },
      Block {
        r#type: "text".into(),
        value: "CENTRO".into(),
        align: "center".into(),
        bold: true,
        ..Default::default()
      },
      Block {
        r#type: "text".into(),
        value: "DIREITA".into(),
        align: "right".into(),
        bold: true,
        ..Default::default()
      },
      Block { r#type: "separator".into(), ..Default::default() },
      Block {
        r#type: "text".into(),
        value: "Se voce leu ate aqui:".into(),
        bold: true,
        ..Default::default()
      },
      Block {
        r#type: "text".into(),
        value: "1. o corte funcionou".into(),
        ..Default::default()
      },
      Block {
        r#type: "text".into(),
        value: "2. a bobina tem >= 48 colunas".into(),
        ..Default::default()
      },
      Block {
        r#type: "text".into(),
        value: "3. alinhou em 3 direcoes".into(),
        ..Default::default()
      },
      Block { r#type: "text".into(), value: format!("em {ts}", ts = now_ms()), align: "right".into(), ..Default::default() },
      Block { r#type: "feed".into(), lines: 3, ..Default::default() },
      Block { r#type: "cut".into(), ..Default::default() },
    ],
  };

  let order = Order::default();
  let bytes = render(&template, &order)?;
  let profile = pdv_shared::app_config().unwrap_or_default().printers;
  let profile = profile.profile(&destination)?;
  let bytes_sent = dispatch(profile, &destination, &bytes)?;
  Ok(PrintTestResult { destination, bytes_sent })
}

/// Imprime um ticket montado pela nuvem.
///
/// O `template` vem no payload em vez de ser embutido no binário: a fase 2
/// passa a buscá-lo do banco, e o app já fica com o contrato certo desde já —
/// uma mudança de layout vira configuração, não instalador.
#[tauri::command]
pub fn print_ticket(input: PrintTicketInput) -> Result<PrintResult, String> {
  let config: AppConfig = pdv_shared::app_config().unwrap_or_default();
  let profile = config.printers.profile(&input.destination)?;
  let bytes = render(&input.template, &input.order)?;
  let bytes_sent = dispatch(profile, &input.destination, &bytes)?;
  Ok(PrintResult {
    destination: input.destination,
    order_id: input.order_id,
    bytes_sent,
    printed_at_ms: now_ms(),
  })
}

/// Escolhe o transporte e entrega os bytes. Único ponto do app que sabe
/// distinguir spooler de TCP — para que trocar o config seja o único jeito de
/// trocar o caminho, e o renderer não saiba qual é.
fn dispatch(profile: &PrinterProfile, destination: &str, bytes: &[u8]) -> Result<usize, String> {
  match profile.transport {
    Transport::Spooler => {
      let name = profile
        .printer_name
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| {
          format!("nenhuma fila de impressão configurada para o destino {destination}")
        })?;
      #[cfg(windows)]
      {
        super::spooler::print_raw(name, bytes)?;
        Ok(bytes.len())
      }
      #[cfg(not(windows))]
      {
        let _ = name;
        Err("imprimir no spooler só funciona no app Windows.".to_string())
      }
    }
    Transport::Tcp => {
      let address = profile
        .socket
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
          format!("nenhum endereço de impressora configurado para o destino {destination}")
        })?;
      super::transport::send_tcp(address, bytes)?;
      Ok(bytes.len())
    }
  }
}

/// Entrada de `print_ticket`. `camelCase` só no nível de cima (é o que o JS
/// envia); dentro de `order` o contrato é snake_case, porque quem monta é o
/// backend — ver [`super::escpos`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintTicketInput {
  pub order_id: String,
  pub destination: String,
  pub order: Order,
  pub template: Template,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
  pub destination: String,
  pub order_id: String,
  pub bytes_sent: usize,
  pub printed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintTestResult {
  pub destination: String,
  pub bytes_sent: usize,
}

#[cfg(test)]
mod tests {
  use super::*;
  // `use super::*` traz o que `commands` importou (incluindo o módulo `status`),
  // mas não o conteúdo desse módulo: `SensorStatus` e `PrintersConfig` precisam
  // de import próprio. No app v1 (`frontend/src-tauri`) esses dois imports
  // faltam e a suíte não compila — por isso a cópia local, em vez de confiar
  // no glob.
  use super::status::SensorStatus;
  use pdv_shared::PrintersConfig;

  fn profile(transport: Transport, name: Option<&str>, socket: Option<&str>) -> PrinterProfile {
    PrinterProfile {
      transport,
      printer_name: name.map(str::to_string),
      socket: socket.map(str::to_string),
      template_id: None,
    }
  }

  /// O gate é a parte que bloqueia operação, então é a parte com mais casos:
  /// cada um aqui é um cenário que acontece numa loja.
  #[test]
  fn sem_impressora_configurada_nao_esta_pronto() {
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, None, None),
      SensorStatus::unknown("sem ip"),
      SpoolerStatus::default(),
    );
    assert!(!h.ready);
    assert!(h.message.unwrap().contains("nenhuma impressora"));
  }

  #[test]
  fn fila_inexistente_nao_esta_pronta() {
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, Some("MP-4200"), None),
      SensorStatus::unknown("sem ip"),
      SpoolerStatus::default(),
    );
    assert!(!h.ready);
    assert!(h.message.unwrap().contains("não existe nesta máquina"));
  }

  #[test]
  fn fila_quebrada_mas_sem_socket_nao_avisa_bobina() {
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, Some("MP-4200"), None),
      SensorStatus::unknown("usb"),
      SpoolerStatus { found: true, port: "USB001".into(), raw: 0 },
    );
    // A impressora existe e não reporta erro: pronta, mas o app tem que dizer
    // que a bobina é responsabilidade do operador.
    assert!(h.ready);
    assert!(!h.can_report_paper);
    assert!(h.message.unwrap().contains("não reporta falta de papel"));
  }

  #[test]
  fn socket_dizendo_sem_bobina_bloqueia_e_a_proveniencia_e_o_socket() {
    let sensor = SensorStatus {
      reachable: true,
      paper: "out".into(),
      ..Default::default()
    };
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, Some("MP-4200"), Some("192.168.0.50:9100")),
      sensor,
      SpoolerStatus { found: true, port: String::new(), raw: 0 },
    );
    assert!(!h.ready);
    assert_eq!(h.paper, "out");
    assert_eq!(h.paper_source, "socket");
    assert!(h.can_report_paper);
  }

  #[test]
  fn bobina_no_fim_nao_bloqueia() {
    let sensor = SensorStatus {
      reachable: true,
      paper: "near_end".into(),
      ..Default::default()
    };
    let h = status::compose(
      "kitchen",
      &profile(Transport::Tcp, None, Some("192.168.0.50:9100")),
      sensor,
      SpoolerStatus::default(),
    );
    assert!(h.ready, "bobina acabando não pode derrubar a cozinha");
    assert_eq!(h.paper, "near_end");
  }

  #[test]
  fn driver_reportando_paper_out_bloqueia_mesmo_sem_socket() {
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, Some("MP-4200"), None),
      SensorStatus::unknown("usb"),
      // 16 = PRINTER_STATUS_PAPER_OUT
      SpoolerStatus { found: true, port: "USB001".into(), raw: 16 },
    );
    assert!(!h.ready);
    assert_eq!(h.paper, "out");
    assert_eq!(h.paper_source, "spooler");
    // Viu o driver marcar papel, então ele é capaz de reportar.
    assert!(h.can_report_paper);
  }

  #[test]
  fn fila_ocupada_nao_e_quebrada() {
    // BUSY(512) | PRINTING(1024) | PROCESSING(16384): estados normais de fila
    // ocupada. Bloquear a cozinha aqui seria o pior bug possível.
    let h = status::compose(
      "kitchen",
      &profile(Transport::Spooler, Some("MP-4200"), None),
      SensorStatus::unknown("usb"),
      SpoolerStatus { found: true, port: "USB001".into(), raw: 512 | 1024 | 16384 },
    );
    assert!(h.ready);
  }

  #[test]
  fn tampa_aberta_por_socket_bloqueia() {
    let sensor = SensorStatus {
      reachable: true,
      paper: "ok".into(),
      cover_open: true,
      ..Default::default()
    };
    let h = status::compose(
      "kitchen",
      &profile(Transport::Tcp, None, Some("192.168.0.50:9100")),
      sensor,
      SpoolerStatus::default(),
    );
    assert!(!h.ready);
    assert!(h.cover_open);
  }

  #[test]
  fn destino_desconhecido_e_erro() {
    let config = PrintersConfig::default();
    assert!(config.profile("bar").is_err());
    assert!(config.profile("kitchen").is_ok());
  }
}
