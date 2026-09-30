//! Transporte TCP 9100 e sondagem `DLE EOT`.
//!
//! Duas funções que parecem uma, mas não são: `send_tcp` **imprime** (usada
//! quando o transporte configurado é `tcp`), `query_dle_eot` **pergunta o estado
//! do aparelho** e roda mesmo com a impressão saindo pelo spooler. É essa
//! segunda que dá o sinal de bobina sem passar pelo driver do Windows.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Divide `host:porta` e resolve. `ToSocketAddrs` é síncrono e aqui não há
/// alternativa sem dependency nova; os endereços são IPs literals ou nomes de
/// rede local, então a resolução é rápida na prática.
fn connect(address: &str, timeout: Duration) -> Result<TcpStream, String> {
  let mut last = format!("endereço inválido: {address}");
  for addr in address.to_socket_addrs().map_err(|e| e.to_string())? {
    match TcpStream::connect_timeout(&addr, timeout) {
      Ok(stream) => {
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let _ = stream.set_read_timeout(Some(STATUS_TIMEOUT));
        return Ok(stream);
      }
      Err(err) => last = format!("{addr}: {err}"),
    }
  }
  Err(last)
}

/// Envia o ticket cru. Espelha `sendTCP` do Go (`main.go:803-815`).
pub fn send_tcp(address: &str, buffer: &[u8]) -> Result<(), String> {
  let mut stream = connect(address, CONNECT_TIMEOUT)?;
  stream
    .write_all(buffer)
    .map_err(|e| format!("enviar ESC/POS para {address}: {e}"))?;
  // O corte sai no fim do buffer. Sem esse flush a conexão fechando pode
  // deixar o GS V no spooler do aparelho e o papel não ser cortado.
  stream
    .flush()
    .map_err(|e| format!("finalizar envio para {address}: {e}"))
}

/// `DLE EOT n` — pergunta o status real da impressora.
///
/// O aparelho responde com **um byte**, o que torna a leitura simples, mas o
/// que torna a funçãonhona é o `read_exact`: `read()` pode voltar com 0 bytes
/// (fim de stream) e tratar isso como resposta daria "sem papel" para uma
/// impressora que simplesmente desligou.
pub fn query_dle_eot(address: &str, n: u8) -> Result<u8, String> {
  let mut stream = connect(address, STATUS_TIMEOUT)?;
  stream
    .write_all(&[0x10, 0x04, n])
    .map_err(|e| format!("enviar DLE EOT {n}: {e}"))?;
  let mut response = [0u8; 1];
  stream
    .read_exact(&mut response)
    .map_err(|e| format!("ler resposta do DLE EOT {n}: {e}"))?;
  Ok(response[0])
}
