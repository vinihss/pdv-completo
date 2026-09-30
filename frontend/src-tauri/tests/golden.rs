//! Paridade byte a byte com o renderizador Go.
//!
//! O daemon Go é o golden master: `printer/daemon/golden_test.go` renderiza
//! `fixture-order.json` com os três templates e grava `testdata/golden/*.bin`.
//! Este teste faz exatamente o mesmo render em Rust e compara os bytes.
//!
//! É o teste que impede a troca de transporte (spooler do Windows) de virar
//! também uma troca de cupom: se o Rust emitir um byte diferente do Go, este
//! teste quebra — e o conserto é no Rust.
//!
//! Para regenerar o esperado depois de uma mudança **intencionada** no Go:
//! `UPDATE_GOLDEN=1 go test ./...` em `printer/daemon/`.

use std::fs;
use std::path::{Path, PathBuf};

use app_lib::printing::escpos::{render, Order, Template};

/// Raiz do repositório a partir do crate (`frontend/src-tauri` → `../..`).
fn repo(relative: &str) -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../..")
    .join(relative)
}

fn read(relative: &str) -> Vec<u8> {
  let path = repo(relative);
  fs::read(&path).unwrap_or_else(|e| panic!("ler {}: {e}", path.display()))
}

fn template(name: &str) -> Template {
  serde_json::from_slice(&read(&format!("printer/daemon/templates/{name}.json")))
    .unwrap_or_else(|e| panic!("parsear template {name}: {e}"))
}

fn order() -> Order {
  serde_json::from_slice(&read("printer/daemon/testdata/fixture-order.json"))
    .expect("parsear fixture-order.json")
}

/// Os três templates que o daemon embute (`//go:embed templates/*.json`).
const TEMPLATES: [&str; 3] = ["kitchen-default", "courier-default", "fiscal-default"];

#[test]
fn rust_imprime_o_mesmo_que_o_go() {
  let o = order();
  for name in TEMPLATES {
    let got = render(&template(name), &o)
      .unwrap_or_else(|e| panic!("render {name}: {e}"));
    let want = read(&format!("printer/daemon/testdata/golden/{name}.bin"));

    assert_eq!(
      got.len(),
      want.len(),
      "{name}: tamanho divergente — o Go gerou {}, o Rust gerou {}",
      want.len(),
      got.len()
    );
    if let Some(i) = got.iter().zip(&want).position(|(a, b)| a != b) {
      panic!(
        "{name}: primeiro byte divergente no índice {i}: go=0x{:02x} rust=0x{:02x}\n  go:   {}\n  rust: {}",
        want[i],
        got[i],
        hex(&want[i.saturating_sub(12)..(i + 12).min(want.len())]),
        hex(&got[i.saturating_sub(12)..(i + 12).min(got.len())]),
      );
    }
  }
}

/// Um cupom real começa com `ESC @` (reset) e termina com o corte. Se algum
/// dos dois sumir, a impressora compartilhada entre coales e caixa herda
/// estado do job anterior — e o corte some é o que deixa a bobina saindo torta.
#[test]
fn cupome_tem_reset_no_inicio_e_corte_no_fim() {
  let bytes = render(&template("kitchen-default"), &order()).unwrap();
  assert_eq!(&bytes[..2], &[0x1b, 0x40], "sem ESC @ no início");
  assert_eq!(&bytes[bytes.len() - 4..], &[0x1d, 0x56, 0x42, 0x00], "sem GS V B 0 no fim");
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}
