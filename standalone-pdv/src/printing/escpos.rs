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
//!
//! A única diferença em relação à cópia de `frontend/src-tauri` (o app em
//! produção, que fica lá durante a transição) está em **um teste**, não no
//! renderer: `size_normal_e_sempre_reemitido_apos_o_texto` afirmava uma ordem de
//! bytes que o renderer não produz, e falhava. O motivo está escrito no próprio
//! teste. Vale a correção ser espelhada lá.

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

/// Construtor de bytes ESC/POS. Espelha o `type escpos` do Go.
#[derive(Debug, Default)]
pub struct Escpos {
  data: Vec<u8>,
  /// `None` = render lógico em UTF-8 (é o que os goldens comparam).
  /// `Some` = produção: sanitiza e converte para a code page do perfil.
  page: Option<&'static str>,
}

impl Escpos {
  /// Render lógico: UTF-8, sem `ESC t`. É o que o golden do Rust e o golden
  /// do Go esperam, então este construtor NÃO converte.
  pub fn new() -> Self {
    let mut e = Escpos {
      data: Vec::new(),
      page: None,
    };
    e.init();
    e
  }

  /// Render de produção: aplica a code page do perfil. Com `page = None`
  /// (encoding utf-8) o resultado é idêntico a [`Escpos::new`].
  pub fn with_page(page: Option<&'static str>, code_page: u8) -> Self {
    let mut e = Escpos {
      data: Vec::new(),
      page,
    };
    e.init();
    // `ESC t` logo depois do `ESC @` e antes de qualquer bloco: a página
    // precisa valer desde o primeiro byte de texto, e o init do cupom é o
    // único ponto onde a impressora ainda está no estado dela. Mesma
    // posição que o Go usa (render.go:94-98).
    if page.is_some() {
      e.data.extend_from_slice(&[0x1b, 0x74, code_page]);
    }
    e
  }

  /// `ESC @` — reset. O Go emite isso no início de **todo** ticket
  /// (`b.init()`), então o mesmo aqui: uma impressora compartilhada entre
  /// coales e caixa não pode herdar negrito ou alinhamento do job anterior.
  fn init(&mut self) {
    self.data.extend_from_slice(&[0x1b, 0x40]);
  }

  /// Único caminho por onde texto do pedido vira byte: sanitiza (nada de
  /// ESC/POS vindo de nome de item) e codifica na página. Passar por aqui em
  /// vez de dentro de `line()` é o que mantém o builder burro e impossível de
  /// usar errado — o mesmo argumento do `emit()` no Go.
  pub fn line(&mut self, s: &str) {
    match self.page {
      None => self
        .data
        .extend_from_slice(super::codepage::sanitize(s).as_bytes()),
      Some(page) => self.data.extend_from_slice(&super::codepage::encode(
        page,
        &super::codepage::sanitize(s),
      )),
    }
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
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0]);
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 67, 4]);
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 69, 48]);
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, size as u8, (size >> 8) as u8, 49, 80, 48]);
    self.data.extend_from_slice(data);
    self
      .data
      .extend_from_slice(&[0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48]);
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
/// Renderiza o ticket em UTF-8, sem code page. É o render **lógico**: é o que
/// os goldens comparam, e por isso ele não converte a página (sanitiza sempre).
///
/// Para produção use [`render_for_profile`], que aplica a code page do perfil.
pub fn render(template: &Template, order: &Order) -> Result<Vec<u8>, String> {
  render_with_page(template, order, None, 0)
}

/// Render de produção: aplica a code page do perfil do destino. Com
/// `encoding: utf-8` (`page = None`) o resultado é idêntico a [`render`].
pub fn render_for_profile(
  template: &Template,
  order: &Order,
  encoding: Option<&str>,
  code_page_override: Option<i64>,
) -> Result<Vec<u8>, String> {
  match super::codepage::resolve(encoding, code_page_override) {
    Some((page, cp)) => render_with_page(template, order, Some(page), cp),
    None => render_with_page(template, order, None, 0),
  }
}

/// Faz o trabalho. `page = None` é UTF-8 lógico.
fn render_with_page(
  template: &Template,
  order: &Order,
  page: Option<&'static str>,
  code_page: u8,
) -> Result<Vec<u8>, String> {
  let mut b = Escpos::with_page(page, code_page);
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
        b.line(&format!(
          "{}, {}",
          order.delivery.address, order.delivery.number
        ));
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
  fn item_com_esc_nao_injeta_comando_na_impressora() {
    // Regressão do defeito que motivou o `codepage`: `line()` fazia
    // `s.as_bytes()` cru, então ESC/GS digitado no nome de um item virava
    // comando. `GS V` corta o papel, `ESC p` abre a gaveta.
    let mut o = order();
    o.items = vec![Item {
      name: "Cacha\u{1b}d\u{1b}".into(),
      quantity: 1,
      ..Default::default()
    }];
    let t = Template {
      blocks: vec![Block {
        r#type: "items".into(),
        ..Default::default()
      }],
      ..Default::default()
    };

    for page in [None, Some("cp850"), Some("cp858"), Some("windows-1252")] {
      let bytes = render_with_page(&t, &o, page, 2).unwrap();
      // O texto é distinguido dos comandos: ESC @ e ESC t são do renderer, e
      // valem. O que não pode é ESC vindo DEPOIS do primeiro bloco de texto.
      let primeiro_texto = bytes
        .windows(2)
        .position(|w| w == [0x1b, b'a'])
        .expect("o cupom tem alinhamento antes do texto");
      let depois_do_texto = &bytes[primeiro_texto..];
      // Nenhum ESC de texto deve existir: conta os ESC e compara com os que o
      // renderer emite por conta própria (init + ESC t + alinhamentos).
      let esc_do_texto = depois_do_texto.iter().filter(|b| **b == 0x1b).count();
      let alvos = depois_do_texto
        .windows(2)
        .filter(|w| w[0] == 0x1b && (w[1] == b'a' || w[1] == b'E' || w[1] == b't'))
        .count();
      assert_eq!(
        esc_do_texto, alvos,
        "ESC do texto do pedido chegou ao cupom (page={page:?}): {bytes:02x?}"
      );
    }
  }

  #[test]
  fn render_de_producao_converte_para_cp850() {
    let mut o = order();
    o.items = vec![Item {
      name: "Porção de pão de queijo".into(),
      quantity: 1,
      ..Default::default()
    }];
    let t = Template {
      blocks: vec![Block {
        r#type: "items".into(),
        ..Default::default()
      }],
      ..Default::default()
    };

    let bytes = render_for_profile(&t, &o, None, None).unwrap();
    // cp850: Ç = 0x87 e ã = 0xC6 — os mesmos bytes que o Go espera em
    // TestEncodeCP850 (hardening_test.go:261). Byte único, não UTF-8.
    assert!(
      bytes.contains(&0x87),
      "Ç não virou 0x87 (cp850): {bytes:02x?}"
    );
    assert!(
      bytes.contains(&0xC6),
      "ã não virou 0xC6 (cp850): {bytes:02x?}"
    );
    // O ESC t tem que vir logo depois do ESC @, senão a página só vale depois
    // do primeiro texto — e o primeiro texto sai na página errada.
    assert_eq!(&bytes[0..2], &[0x1b, 0x40], "ESC @ no início");
    assert_eq!(
      &bytes[2..5],
      &[0x1b, 0x74, 2],
      "ESC t 2 (cp850) logo depois"
    );
  }

  #[test]
  fn utf8_no_perfil_desliga_a_conversao() {
    let mut o = order();
    o.items = vec![Item {
      name: "Porção".into(),
      quantity: 1,
      ..Default::default()
    }];
    let t = Template {
      blocks: vec![Block {
        r#type: "items".into(),
        ..Default::default()
      }],
      ..Default::default()
    };

    let utf8 = render_for_profile(&t, &o, Some("utf-8"), None).unwrap();
    let logico = render(&t, &o).unwrap();
    assert_eq!(utf8, logico, "utf-8 tem que ser idêntico ao render lógico");
    assert!(
      !utf8.windows(2).any(|w| w == [0x1b, 0x74]),
      "utf-8 não emite ESC t"
    );
    // Sanitização continua valendo mesmo sem conversão: é segurança, não
    // formatação. O nome "a\x1bb" tem que virar "ab" — sem ESC no meio.
    let mut o2 = o.clone();
    o2.items = vec![Item {
      name: "a\u{1b}b".into(),
      quantity: 1,
      ..Default::default()
    }];
    let bytes = render_for_profile(&t, &o2, Some("utf-8"), None).unwrap();
    assert!(
      bytes.windows(6).any(|w| w == b"1x ab\n"),
      "o ESC do nome sobreviveu no render utf-8: {bytes:02x?}"
    );
    assert!(
      !bytes.windows(2).any(|w| w == b"a\x1b"),
      "ESC dentro do texto do item: {bytes:02x?}"
    );
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
    // O que este teste segura: o bloco `text` emite alinhamento, negrito,
    // tamanho, o texto e **depois** volta tamanho e negrito ao normal (ver o
    // braço "text" do `render`). Inverter essa ordem faria o separador
    // seguinte herdar o tamanho dobrado — e o `separator` não emite reset
    // próprio, ele só alinha e escreve a linha. O nome do teste é esse
    // contrato: normal sempre reemitido *após o texto*.
    //
    // Âncora: o TEXTO renderizado, não um `ESC a 0`. A versão que veio do app
    // v1 (`frontend/src-tauri/src/printing/escpos.rs`, mesmo teste lá) procurava
    // o primeiro `ESC a 0` e afirmava que logo depois dele vinha o tamanho
    // normal — mas o primeiro `ESC a 0` é o alinhamento do *cabeçalho*, e logo
    // depois dele vem `ESC E 1`, o negrito ligado. Aquele teste nunca rodou
    // porque a suíte dele nem compila (faltam dois imports no `commands.rs`);
    // aqui roda. O renderer em si é o que o golden master prova, byte a byte.
    let text_at = bytes
      .windows(7)
      .position(|w| w == b"PEDIDO\n")
      .expect("texto renderizado");
    let after = text_at + 7;
    // Fechamento do bloco de texto: tamanho normal, depois negrito desligado.
    assert_eq!(&bytes[after..after + 3], &[0x1d, 0x21, 0x00], "tamanho volta ao normal");
    assert_eq!(&bytes[after + 3..after + 6], &[0x1b, 0x45, 0x00], "negrito desligado");
    // E o separador vem logo em seguida, já sem nada herdado: alinhamento
    // próprio e a linha com a largura das colunas do template.
    assert_eq!(&bytes[after + 6..after + 9], &[0x1b, 0x61, 0], "separador alinhado à esquerda");
    assert_eq!(&bytes[after + 9..], b"--------\n", "separador com 8 colunas");
  }
}
