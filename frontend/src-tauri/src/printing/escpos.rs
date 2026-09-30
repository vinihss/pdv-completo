//! Renderer ESC/POS.
//!
//! Port **byte a byte** do `render()` do daemon Go (`printer/daemon/main.go`).
//! A paridade importa: os testes golden em `tests/golden.rs` comparam a saída
//! deste arquivo com os `.bin` gerados pelo renderizador Go. Qualquer mudança
//! aqui queMexa nos bytes tem que regenerar os goldens pelo Go
//! (`UPDATE_GOLDEN=1 go test ./printer/daemon/...`), nunca escrevendo o
//! esperado à mão — senão a comparação deixa de provar a paridade.
//!
//! O contrato de entrada é o mesmo envelope que o backend e o `daemonOrder.js`
//! já produzem (`printer.mapper.ts` / `entities/printer/lib/daemonOrder.js`),
//! em snake_case. Por isso **não** existe um mapper de pedido neste módulo:
//! quem monta o payload é a nuvem, e duas implementações do mesmo mapeamento
//! divergem em silêncio. Aqui só deserializa e renderiza.

use serde::Deserialize;

/// Um bloco do template. Mesmos campos do `Block` do Go (`main.go:71`).
///
/// `serde(default)` em tudo: o Go tratava campo ausente como zero, e um
/// template ou pedido incompleto não pode derrubar o cupom inteiro. Melhor um
/// campo vazio na bobina do que nenhuma bobina.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Block {
  pub r#type: String,
  pub value: String,
  pub align: String,
  pub bold: bool,
  pub size: String,
  pub lines: i32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Template {
  pub id: String,
  pub version: i32,
  pub destination: String,
  /// Colunas da bobina. 48 = 80 mm a 203 dpi (a MP-4200), 32 = 58 mm.
  /// Só o separador usa, mas é daqui que vem a largura da linha.
  pub columns: i32,
  pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Item {
  pub name: String,
  pub quantity: i32,
  pub unit_price_cents: i64,
  pub notes: String,
  pub addons: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Customer {
  pub name: String,
  pub phone: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Delivery {
  pub address: String,
  pub number: String,
  pub complement: String,
  pub neighborhood: String,
  pub reference: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Payment {
  pub method: String,
  pub change_cents: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Fiscal {
  pub company: String,
  pub cnpj: String,
  pub access_key: String,
  pub qr_code_url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Order {
  pub number: String,
  pub created_at: String,
  pub r#type: String,
  pub notes: String,
  pub items: Vec<Item>,
  pub total_cents: i64,
  pub customer: Customer,
  pub delivery: Delivery,
  pub payment: Payment,
  pub fiscal: Fiscal,
}

/// Envelope que chega do backend (mesmo formato do `POST /api/print` do Go,
/// `main.go:118`). `template_id` é opcional: sem ele, o destino escolhe o
/// template padrão embutido.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct PrintRequest {
  pub order_id: String,
  pub destination: String,
  pub template_id: String,
  pub order: Order,
}

/// Construtor de bytes ESC/POS. Espelha o `type escpos` do Go (`main.go:905`).
#[derive(Debug, Default)]
pub struct Escpos {
  data: Vec<u8>,
}

impl Escpos {
  pub fn new() -> Self {
    let mut e = Escpos { data: Vec::new() };
    e.init();
    e
  }

  /// `ESC @` — reset. O Go emite isso no início de **todo** ticket
  /// (`b.init()`), então o mesmo aqui: uma impressora compartilhada entre
  /// coales e caixa não pode herdar negrito ou alinhamento do job anterior.
  fn init(&mut self) {
    self.data.extend_from_slice(&[0x1b, 0x40]);
  }

  pub fn line(&mut self, s: &str) {
    self.data.extend_from_slice(s.as_bytes());
    self.data.push(b'\n');
  }

  pub fn align(&mut self, a: &str) {
    let v = match a {
      "center" => 1,
      "right" => 2,
      _ => 0,
    };
    self.data.extend_from_slice(&[0x1b, 0x61, v]);
  }

  pub fn bold(&mut self, on: bool) {
    self.data.extend_from_slice(&[0x1b, 0x45, u8::from(on)]);
  }

  pub fn size(&mut self, s: &str) {
    // GS ! 0x11 = largura e altura x2. O Go emite o comando de "voltar ao
    // normal" também quando o bloco não pediu tamanho — daí o `else` com
    // 0x00, e não uma no-op.
    let v: u8 = if s == "double" { 0x11 } else { 0x00 };
    self.data.extend_from_slice(&[0x1d, 0x21, v]);
  }

  pub fn feed(&mut self, n: i32) {
    for _ in 0..n {
      self.data.push(b'\n');
    }
  }

  /// `GS V B 0` — corte parcial com alimentação. O `0x42` é o modo "B": corta
  /// e deixa a posição parcial na folha, que é o que a bobina 80 mm precisa
  /// para não cortar a próxima comanda pela metade.
  pub fn cut(&mut self) {
    self.data.extend_from_slice(&[0x1d, 0x56, 0x42, 0x00]);
  }

  pub fn bytes(&self) -> &[u8] {
    &self.data
  }

  /// GS ( k — QR Code. Não emite nada para valor vazio (mesma guarda do Go,
  /// `main.go:941-943`): o `fiscal-default.json` tem um bloco qrcode com
  /// `{{fiscal.qr_code_url}}` e, sem URL, o ticket fiscal sai sem QR em vez
  /// de sair com lixo.
  pub fn qr_code(&mut self, value: &str) {
    if value.is_empty() {
      return;
    }
    let data = value.as_bytes();
    let size = (data.len() + 3) as u16;
    // Modelo 2, nível de correção M, tamanho em bytes, dados, imprimir.
    self.data.extend_from_slice(&[0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0]);
    self.data.extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 67, 4]);
    self.data.extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 69, 48]);
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, size as u8, (size >> 8) as u8, 49, 80, 48]);
    self.data.extend_from_slice(data);
    self.data.extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48]);
    self.feed(1);
  }
}

/// `R$ 12,34` a partir de centavos. Mesmo formato do Go (`main.go:903`).
pub fn money(cents: i64) -> String {
  format!("R$ {},{:02}", cents / 100, cents % 100)
}

/// Troca única de `{{chave}}` pelo valor do pedido.
///
/// O Go faz `strings.ReplaceAll` em sequência (`main.go:896-902`). Aqui é uma
/// passada só, e isso é **melhor**: se um nome de produto contiver literalmente
/// `{{order.type}}`, a versão sequencial do Go reescreveria a segunda
///occurrence. Passada única não. Nos casos reais de cardápio o resultado é
/// idêntico — o que o golden test confere.
fn expand(value: &str, order: &Order) -> String {
  const KEYS: [&str; 8] = [
    "order.number",
    "order.created_at",
    "order.type",
    "order.notes",
    "fiscal.company",
    "fiscal.cnpj",
    "fiscal.access_key",
    "fiscal.qr_code_url",
  ];

  let lookup = |key: &str| -> Option<String> {
    Some(match key {
      "order.number" => order.number.clone(),
      "order.created_at" => order.created_at.clone(),
      "order.type" => order.r#type.to_uppercase(),
      "order.notes" => order.notes.clone(),
      "fiscal.company" => order.fiscal.company.clone(),
      "fiscal.cnpj" => order.fiscal.cnpj.clone(),
      "fiscal.access_key" => order.fiscal.access_key.clone(),
      "fiscal.qr_code_url" => order.fiscal.qr_code_url.clone(),
      _ => return None,
    })
  };

  let mut out = String::with_capacity(value.len());
  let mut rest = value;
  while let Some(start) = rest.find("{{") {
    let after = &rest[start + 2..];
    let Some(end) = after.find("}}") else {
      break;
    };
    let key = &after[..end];
    match KEYS.iter().find(|k| **k == key).and_then(|k| lookup(k)) {
      // Placeholder conhecido: some com a chave e joga o valor.
      Some(replacement) => {
        out.push_str(&rest[..start]);
        out.push_str(&replacement);
      }
      // Chave desconhecida: mantém o texto como estava, para o operador ver o
      // erro no papel em vez de a linha sumir.
      None => out.push_str(&rest[..start + 2 + end + 2]),
    }
    rest = &after[end + 2..];
  }
  out.push_str(rest);
  out
}

/// Renderiza o ticket. Espelha `render()` (`main.go:817-894`), inclusive a
/// ordem dos comandos: um bloco `text` emite alinhamento, negrito, tamanho,
/// o texto, e **depois** volta tamanho e negrito ao normal. Inverter essa
/// ordem faria o separador seguinte herdar negrito.
pub fn render(template: &Template, order: &Order) -> Result<Vec<u8>, String> {
  let mut b = Escpos::new();
  for block in &template.blocks {
    match block.r#type.as_str() {
      "text" => {
        b.align(&block.align);
        b.bold(block.bold);
        b.size(&block.size);
        b.line(&expand(&block.value, order));
        b.size("");
        b.bold(false);
      }
      "separator" => {
        b.align("left");
        b.line(&"-".repeat(template.columns.max(0) as usize));
      }
      "items" => {
        b.align("left");
        for item in &order.items {
          b.bold(true);
          b.line(&format!("{}x {}", item.quantity, item.name));
          b.bold(false);
          for addon in &item.addons {
            b.line(&format!("  + {addon}"));
          }
          if !item.notes.is_empty() {
            b.line(&format!("  OBS: {}", item.notes));
          }
        }
      }
      "notes" => {
        if !order.notes.is_empty() {
          b.bold(true);
          b.line("OBSERVAÇÕES");
          b.bold(false);
          b.line(&order.notes);
        }
      }
      "customer" => {
        b.bold(true);
        b.line("CLIENTE");
        b.bold(false);
        b.line(&order.customer.name);
        b.line(&format!("Telefone: {}", order.customer.phone));
      }
      "delivery" => {
        b.bold(true);
        b.line("ENDEREÇO");
        b.bold(false);
        b.line(&format!("{}, {}", order.delivery.address, order.delivery.number));
        if !order.delivery.complement.is_empty() {
          b.line(&format!("Complemento: {}", order.delivery.complement));
        }
        if !order.delivery.neighborhood.is_empty() {
          b.line(&format!("Bairro: {}", order.delivery.neighborhood));
        }
        if !order.delivery.reference.is_empty() {
          b.line(&format!("Referência: {}", order.delivery.reference));
        }
      }
      "payment" => {
        b.line(&format!("Pagamento: {}", order.payment.method));
        if order.payment.change_cents > 0 {
          b.line(&format!("Troco: {}", money(order.payment.change_cents)));
        }
      }
      "total" => {
        b.align("right");
        b.bold(true);
        b.line(&format!("TOTAL: {}", money(order.total_cents)));
        b.bold(false);
      }
      "qrcode" => {
        b.align("center");
        b.qr_code(&expand(&block.value, order));
      }
      "feed" => b.feed(block.lines),
      "cut" => b.cut(),
      // Bloco desconhecido é erro, não silêncio: um template typoado no
      // backend precisa aparecer, não sair sem a seção e ninguém notar.
      other => return Err(format!("bloco desconhecido: {other}")),
    }
  }
  Ok(b.bytes().to_vec())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn order() -> Order {
    Order {
      number: "Mesa 7".into(),
      r#type: "mesa".into(),
      total_cents: 4530,
      ..Default::default()
    }
  }

  #[test]
  fn money_usa_coma_e_dois_digitos() {
    assert_eq!(money(0), "R$ 0,00");
    assert_eq!(money(5), "R$ 0,05");
    assert_eq!(money(500), "R$ 5,00");
    assert_eq!(money(4530), "R$ 45,30");
    assert_eq!(money(1_000_00), "R$ 1000,00");
  }

  #[test]
  fn expand_troca_todos_os_lugares_conhecidos() {
    let mut o = order();
    o.created_at = "2026-09-30 21:04".into();
    o.notes = "sem cebola".into();
    o.fiscal.company = "Bar do Zé".into();
    o.fiscal.cnpj = "11.222.333/0001-44".into();
    o.fiscal.access_key = "3520...".into();
    o.fiscal.qr_code_url = "https://qr".into();

    let got = expand(
      "{{order.number}}|{{order.created_at}}|{{order.type}}|{{order.notes}}|{{fiscal.company}}|{{fiscal.cnpj}}|{{fiscal.access_key}}|{{fiscal.qr_code_url}}",
      &o,
    );
    assert_eq!(
      got,
      "Mesa 7|2026-09-30 21:04|MESA|sem cebola|Bar do Zé|11.222.333/0001-44|3520...|https://qr"
    );
  }

  #[test]
  fn expand_nao_reescreve_placeholder_dentro_do_valor() {
    // A ordem dos ReplaceAll do Go reescreveria isso; a passada única não.
    let mut o = order();
    o.number = "{{order.type}}".into();
    assert_eq!(expand("{{order.number}}", &o), "{{order.type}}");
  }

  #[test]
  fn expand_mantem_chave_desconhecida_visivel() {
    assert_eq!(expand("a{{nao.existe}}b", &order()), "a{{nao.existe}}b");
    assert_eq!(expand("abre {{ sem fechar", &order()), "abre {{ sem fechar");
  }

  #[test]
  fn qr_code_vazio_nao_emite_nada() {
    let mut e = Escpos::new();
    let before = e.bytes().len();
    e.qr_code("");
    assert_eq!(e.bytes().len(), before);
  }

  #[test]
  fn bloco_desconhecido_vira_erro() {
    let t = Template {
      blocks: vec![Block {
        r#type: "grafico".into(),
        ..Default::default()
      }],
      ..Default::default()
    };
    assert_eq!(render(&t, &order()), Err("bloco desconhecido: grafico".into()));
  }

  #[test]
  fn size_normal_e_sempre_reemitido_apos_o_texto() {
    // Se o "voltar ao normal" sumisse, o separador seguinte herdaria o
    // tamanho dobrado da última linha do cabeçalho.
    let t = Template {
      columns: 8,
      blocks: vec![
        Block {
          r#type: "text".into(),
          value: "PEDIDO".into(),
          size: "double".into(),
          bold: true,
          ..Default::default()
        },
        Block {
          r#type: "separator".into(),
          ..Default::default()
        },
      ],
      ..Default::default()
    };
    let bytes = render(&t, &order()).unwrap();
    let sep_at = bytes
      .windows(3)
      .position(|w| w == [0x1b, 0x61, 0])
      .expect("separador alinhado à esquerda");
    // Logo após o alinhamento vem o tamanho normal e o negrito desligado.
    assert_eq!(&bytes[sep_at + 3..sep_at + 5], &[0x1d, 0x21]);
    assert_eq!(bytes[sep_at + 5], 0x00);
    assert_eq!(&bytes[sep_at + 6..sep_at + 8], &[0x1b, 0x45, 0x00]);
  }
}
