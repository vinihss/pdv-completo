//! Spooler do Windows: onde a impressora de verdade é encontrada, aberta e
//! alimentada.
//!
//! `#[cfg(windows)]` inteiro. No Linux/macOS os comandos de impressão
//! devolvem erro explícito — e o golden test continua rodando, porque o
//! renderer não depende de nada daqui.
//!
//! Por que spooler: a impressora térmica de uma loja é USB na maior parte do
//! tempo, e a fila do Windows resolve isso sem ninguém saber o IP nem
//! instalar serviço. É também o caminho que o Gestor do iFood usa.
//!
//! ## O ponto que precisa ser provado em bancada
//!
//! `print_raw` marca o documento como `RAW`, que é a via suportada para
//! passar bytes que só a impressora entende (é o que o `Win32Raw` do
//! python-escpos faz, e o que a doc de `WritePrinter` descreve: com `RAW`, o
//! buffer tem que falar a língua do hardware). Mas **isso depende do driver**:
//! um driver que converte para PCL ou que imposedriver-side paginação quebra o
//! ESC/POS — e o sintoma é corte errado ou alinhamento torto, não erro de API.
//! Por isso o transporte é configurável (`Transport::Tcp` no mesmo config):
//! trocar o caminho não toca no renderizador.

use std::ffi::c_void;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Graphics::Printing::{
  ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetPrinterW, OpenPrinterW,
  StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_DEFAULTSW,
  PRINTER_INFO_2W,
};

use super::status::SpoolerStatus;
use super::PrinterInfo;

/// `EnumPrinters` nível 2: traz nome, porta, driver **e** `Status`.
const ENUM_LEVEL: u32 = 2;
/// `GetPrinter` nível 2: `PRINTER_INFO_2W` com o status do aparelho.
const GETPRINTER_LEVEL: u32 = 2;

/// `pDatatype` que manda o driver passar o buffer cru.
const DATATYPE_RAW: &str = "RAW";

/// `str` → `u16` terminado em NUL. Todo texto que entra no spooler passa por
/// aqui; sem o NUL o Windows lê memória até achar um zero qualquer.
fn wide(s: &str) -> Vec<u16> {
  s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `PWSTR` de um buffer já terminado em NUL. `null_wstr` para campos
/// opcionais (`pOutputFile`).
fn pwstr(buf: &[u16]) -> PWSTR {
  PWSTR(buf.as_ptr() as *mut u16)
}

fn null_wstr() -> PWSTR {
  PWSTR(std::ptr::null_mut())
}

/// `PWSTR` → `String`, tolerante a NUL: os campos de texto do
/// `PRINTER_INFO_2W` vêm vazios como ponteiro nulo, e um campo em branco é
/// melhor que um panic dentro de um `invoke`.
fn from_pwstr(value: PWSTR) -> String {
  if value.is_null() {
    return String::new();
  }
  unsafe { value.to_string().unwrap_or_default() }
}

/// Erro do Windows no número. O erro que interessa ("a fila não existe", "sem
/// permissão", "nenhuma impressora instalada") é só distinguível pelo
/// `GetLastError`, então trazer o número vale mais que uma frase genérica.
fn win_err(op: &str) -> String {
  format!("{op}: erro {} do Windows", unsafe { GetLastError() })
}

/// Lista as filas de impressão. Cada fila vem com o `Status` cru, que é o
/// insumo da fase 0 (bancada): registrar os valores **daquele** driver é o que
/// permite calibrar o gate depois, em vez de confiar no cabeçalho.
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
  let mut needed: u32 = 0;
  let mut returned: u32 = 0;

  // Primeira chamada só para o tamanho. `EnumPrintersW` devolve `ERROR_INSUFFICIENT_BUFFER`
  // nesse caso, e o wrapper do crate trata isso como `Err` — o que é esperado.
  unsafe {
    let _ = EnumPrintersW(
      0,
      PCWSTR::null(),
      ENUM_LEVEL,
      None,
      &mut needed,
      &mut returned,
    );
  }
  if needed == 0 {
    return Ok(Vec::new());
  }

  let mut buffer = vec![0u8; needed as usize];
  unsafe {
    EnumPrintersW(
      0,
      PCWSTR::null(),
      ENUM_LEVEL,
      Some(buffer.as_mut_slice()),
      &mut needed,
      &mut returned,
    )
    .map_err(|_| "falha ao listar as impressoras".to_string())?;
  }

  // O buffer é um u32 de contagem seguido de `returned` structs — sem
  // padding, porque o u32 tem o tamanho do PRINTER_INFO_2W.
  let info_size = std::mem::size_of::<PRINTER_INFO_2W>();
  let mut printers = Vec::with_capacity(returned as usize);
  for index in 0..returned as usize {
    let offset = 4 + index * info_size;
    if offset + info_size > buffer.len() {
      // Buffer menor que o esperado: melhor devolver o que deu para ler do que
      // ler fora dos limites.
      break;
    }
    let info = unsafe { &*(buffer.as_ptr().add(offset) as *const PRINTER_INFO_2W) };
    let name = from_pwstr(info.pPrinterName);
    if name.is_empty() {
      continue;
    }
    printers.push(PrinterInfo {
      name,
      port: from_pwstr(info.pPortName),
      driver: from_pwstr(info.pDriverName),
      location: from_pwstr(info.pLocation),
      raw_status: info.Status,
      is_default: info.Attributes & 4 != 0, // PRINTER_ATTRIBUTE_DEFAULT
    });
  }
  printers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  Ok(printers)
}

/// Abre a fila e devolve o handle. Fechar é responsabilidade de quem chama —
/// o `PrinterHandle` abaixo faz isso no `Drop`, inclusive no caminho de erro.
struct PrinterHandle(windows::Win32::Graphics::Printing::PRINTER_HANDLE);

impl Drop for PrinterHandle {
  fn drop(&mut self) {
    unsafe {
      ClosePrinter(self.0);
    }
  }
}

fn open(printer_name: &str) -> Result<PrinterHandle, String> {
  let name = wide(printer_name);
  let mut handle = windows::Win32::Graphics::Printing::PRINTER_HANDLE::default();
  let defaults = PRINTER_DEFAULTSW {
    // `pDatatype` em DEFAULT = languages de driver; `RAW` aqui sobrescreveria.
    pDatatype: null_wstr(),
    ..Default::default()
  };
  unsafe {
    OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, Some(&defaults))
      .map_err(|_| win_err(&format!("abrir a fila \"{printer_name}\"")))?;
  }
  Ok(PrinterHandle(handle))
}

/// Status publicado pelo driver para uma fila.
///
/// Devolve o `Status` cru e deixa a interpretação para
/// [`crate::printing::status`]: é lá que os bits viram `offline`/`error`/etc.,
/// em código que roda — e é testado — no Linux também. Aqui só o que o Windows
/// disse.
///
/// `PAUSED`, `BUSY`, `PROCESSING`, `PRINTING`, `WARMING_UP` e `INITIALIZING`
/// são estados normais de uma fila ocupada; a composição sabe ignorá-los.
pub fn status(printer_name: &str) -> Result<SpoolerStatus, String> {
  let printer = open(printer_name)?;

  let mut needed: u32 = 0;
  unsafe {
    let _ = GetPrinterW(printer.0, GETPRINTER_LEVEL, None, &mut needed);
  }
  if needed == 0 {
    return Err(win_err(&format!("ler o status de \"{printer_name}\"")));
  }

  let mut buffer = vec![0u8; needed as usize];
  unsafe {
    GetPrinterW(printer.0, GETPRINTER_LEVEL, Some(buffer.as_mut_slice()), &mut needed)
      .map_err(|_| win_err(&format!("ler o status de \"{printer_name}\"")))?;
  }

  let info = unsafe { &*(buffer.as_ptr() as *const PRINTER_INFO_2W) };
  log::debug!("fila \"{printer_name}\" status 0x{:08x}", info.Status);

  Ok(SpoolerStatus {
    found: true,
    port: from_pwstr(info.pPortName),
    raw: info.Status,
  })
}

/// Envia o ticket para a fila.
///
/// O caminho é o da doc do `WritePrinter` para saída raw: `StartDocPrinter` com
/// `pDatatype = "RAW"`, `WritePrinter` com os bytes, e fecha o documento. O
/// `EndPagePrinter` existe porque o spooler conta páginas: sem ele, o job pode
/// ficar marcado como "pendente" na fila mesmo depois de impresso.
pub fn print_raw(printer_name: &str, data: &[u8]) -> Result<(), String> {
  if data.is_empty() {
    return Err("ticket vazio: nada a imprimir".to_string());
  }
  let printer = open(printer_name)?;

  let doc_name = wide("PDV");
  let datatype = wide(DATATYPE_RAW);
  let doc_info = DOC_INFO_1W {
    pDocName: pwstr(&doc_name),
    pOutputFile: null_wstr(),
    pDatatype: pwstr(&datatype),
  };

  let job = unsafe { StartDocPrinterW(printer.0, 1, &doc_info) };
  if job == 0 {
    return Err(win_err(&format!("iniciar o trabalho em \"{printer_name}\"")));
  }

  unsafe {
    if StartPagePrinter(printer.0).as_bool() {
      let mut written: u32 = 0;
      let ok = WritePrinter(printer.0, data.as_ptr() as *const c_void, data.len() as u32, &mut written)
        .as_bool();
      if !ok {
        let err = win_err("escrever na fila");
        let _ = EndDocPrinter(printer.0);
        return Err(err);
      }
      if written as usize != data.len() {
        // Escrita parcial é o pior caso: o spooler aceitou o job, mas o
        // aparelho recebe metade de um ESC/POS e o corte pode não acontecer.
        let _ = EndDocPrinter(printer.0);
        return Err(format!("a fila aceitou só {written} de {} bytes", data.len()));
      }
      if !EndPagePrinter(printer.0).as_bool() {
        let err = win_err("fechar a página");
        let _ = EndDocPrinter(printer.0);
        return Err(err);
      }
    }
    // `EndDocPrinter` no caminho infeliz também: deixar o documento aberto
    // trava a fila para os próximos jobs da loja.
    if !EndDocPrinter(printer.0).as_bool() {
      return Err(win_err("fechar o trabalho"));
    }
  }

  log::info!("ticket de {} bytes enviado para a fila \"{printer_name}\"", data.len());
  Ok(())
}
