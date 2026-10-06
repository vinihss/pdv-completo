//! Code page e sanitização de texto — espelho byte a byte do
//! `printer/daemon/encoder.go`.
//!
//! POR QUE ESTE MÓDULO EXISTE
//! -------------------------
//! O `line()` do [`super::escpos`] fazia `s.as_bytes()`, ou seja, emitia UTF-8
//! cru e sem filtrar nada. Duas consequências, uma cosmética e uma séria:
//!
//! 1. Acentos saíam ilegíveis: a térmica em CP850 não entende UTF-8.
//! 2. Um nome de item com `ESC` injetava comandos na impressora — `GS V` corta
//!    o papel, `ESC p` abre a gaveta. `Item.name` é texto que o garçom digita,
//!    então isso é entrada de usuário chegando cru até o comando.
//!
//! O Go já resolvia os dois em `emit()`:
//!
//! ```go
//! emit := func(s string) string {
//!     return string(enc.encode(sanitizeText(s)))
//! }
//! ```
//!
//! Aqui é o mesmo par, e as tabelas foram copiadas do Go — não digitadas de
//! novo. Divergir aqui é o tipo de erro que o golden em UTF-8 não denuncia,
//! porque o golden exercita só o render lógico.

use std::collections::HashMap;
use std::sync::OnceLock;

// As três tabelas são a direção "byte → code point", na ordem 0x80..0xFF, com
// 128 posições. As duas entradas cruas do Go (`\xad` e `\xa0`) são, em
// Unicode, U+00AD e U+00A0 — escritas aqui como escapes para não depender do
// encoding do arquivo.
//
// O Go gera essas tabelas dos codecs reais (golang.org/x/text charmap) e avisa
// que transpor um acento sai errado na bobina sem o golden denunciar. O mesmo
// vale aqui: mexe com o cuidado de quem não tem impressora à mão.
const CP850_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u{ad}±‗¾¶§÷¸°¨·¹³²■\u{a0}";

/// CP858 é o CP850 com o euro no 0xD5 (o CP850 não tem euro).
const CP858_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u{ad}±‗¾¶§÷¸°¨·¹³²■\u{a0}";

/// CP1252 é a página do Windows: 32 posições de moldura ASCII (0x80-0x9F) e
/// 5 indefinidas (0x81, 0x8D, 0x8F, 0x90, 0x9D). As indefinidas são `\0` e caem
/// no fallback ASCII — mesmo treatment que o Go dá.
const CP1252_HIGH: &str = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ\u{a0}¡¢£¤¥¦§¨©ª«¬\u{ad}®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ";

/// Converte a tabela "byte → rune" no sentido que o encode precisa, rune → byte.
///
/// A inversão não é cosmética: indexar a tabela por `code_point - 0x80` presume
/// que o code point é o byte na página, o que só vale para Latin-1. Em CP850 o
/// `Ç` (U+00C7) mora no byte 0x80, e o byte 0xC7 é o `Ã`.
fn reverse(high: &str) -> HashMap<char, u8> {
  let mut out: HashMap<char, u8> = HashMap::with_capacity(128);
  for (pos, r) in high.chars().enumerate() {
    if pos >= 128 {
      break;
    }
    if r != '\0' {
      // Rune repetido: vence o primeiro byte, que é o que o decodificador do
      // charmap devolve para as duas posições. Nenhuma das três páginas repete
      // hoje, mas o critério fica escrito para o dia em que alguma repetir.
      out.entry(r).or_insert((0x80 + pos) as u8);
    }
  }
  out
}

fn table_cp850() -> &'static HashMap<char, u8> {
  static T: OnceLock<HashMap<char, u8>> = OnceLock::new();
  T.get_or_init(|| reverse(CP850_HIGH))
}
fn table_cp858() -> &'static HashMap<char, u8> {
  static T: OnceLock<HashMap<char, u8>> = OnceLock::new();
  T.get_or_init(|| reverse(CP858_HIGH))
}
fn table_cp1252() -> &'static HashMap<char, u8> {
  static T: OnceLock<HashMap<char, u8>> = OnceLock::new();
  T.get_or_init(|| reverse(CP1252_HIGH))
}

/// ASCII fallback para o que o garçom digita no teclado do celular e não existe
/// em nenhuma das três páginas.
///
/// CJK e emoji NÃO entram, de propósito: mascarár "日" como "?" já é o
/// comportamento certo, e inventar transliteração para ideograma produziria
/// texto ilegível e falso no cupom fiscal. O euro também não entra: em CP850 — a
/// página padrão — ele simplesmente não existe, e trocar símbolo monetário por
/// texto num cupom fiscal é pior que "?", porque "?" pelo menos denuncia.
fn ascii_fallback(r: char) -> Option<&'static str> {
  Some(match r {
    '\u{2013}' | '\u{2014}' | '\u{2212}' | '\u{2022}' | '\u{00b7}' => "-", // – — − • ·
    '\u{2018}' | '\u{2019}' | '\u{00b4}' | '`' => "'",                     // ‘ ’ ´ `
    '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{00ab}' | '\u{00bb}' => "\"", // “ ” „ « »
    '\u{2026}' => "...",                                                   // …
    '\u{2030}' => "%",                                                     // ‰
    '\u{2116}' => "N",                                                     // №
    '\u{2103}' => "C",                                                     // ℃
    '\u{20b9}' => "Rs",                                                    // ₹
    _ => return None,
  })
}

/// Converte UTF-8 nos bytes da página.
///
/// Rune abaixo de 0x80 sai como ele mesmo (caminho quente: nome de produto é
/// quase todo ASCII). Rune alto sai pelo byte que a página dá a ele, pelo
/// fallback ASCII ou por "?" — nessa ordem.
pub fn encode(page: &str, s: &str) -> Vec<u8> {
  let high = match page {
    "cp858" => table_cp858(),
    "windows-1252" | "cp1252" => table_cp1252(),
    _ => table_cp850(),
  };
  let mut out = Vec::with_capacity(s.len());
  for r in s.chars() {
    if (r as u32) < 0x80 {
      out.push(r as u8);
      continue;
    }
    if let Some(b) = high.get(&r) {
      out.push(*b);
      continue;
    }
    if let Some(repl) = ascii_fallback(r) {
      out.extend_from_slice(repl.as_bytes());
      continue;
    }
    out.push(b'?');
  }
  out
}

/// Número do `ESC t n` para a página pedida.
pub fn code_page(page: &str) -> u8 {
  match page {
    "cp858" => 19,
    "windows-1252" | "cp1252" => 16,
    _ => 2, // CP850 é o padrão das térmicas de 80mm
  }
}

/// Resolve `encoding` + `code_page` do perfil para o par (página, `ESC t n`).
///
/// `None` = UTF-8 sem conversão, que é o render lógico. Igual ao `(nil, nil)`
/// do `encoderFor` do Go.
pub fn resolve(
  encoding: Option<&str>,
  code_page_override: Option<i64>,
) -> Option<(&'static str, u8)> {
  let enc = encoding.unwrap_or("").trim().to_ascii_lowercase();
  // Case-insensitive e com espaço tolerado: quem escreve o app.json é o
  // técnico, e "CP850" em outra caixa não é motivo para a impressora parar.
  let page: &'static str = match enc.as_str() {
    "" | "cp850" => "cp850",
    "cp858" => "cp858",
    "windows-1252" | "cp1252" => "windows-1252",
    // utf-8 desliga a conversão — igual ao `return nil, nil` do Go.
    "utf-8" | "utf8" => return None,
    _ => "cp850", // desconhecida cai no padrão; o Go erra, mas o app não tem
                  // onde reportar erro de config sem travar o cupom do caixa.
  };
  let mut cp = code_page(page);
  if let Some(n) = code_page_override {
    // Faixa 0-255 porque é o que o ESC t n aceita de fato: valor fora disso
    // faria a impressora interpretar bytes numa página aleatória, e o sintoma
    // (texto ilegível) aparece longe da causa.
    if (0..=255).contains(&n) {
      cp = n as u8;
    }
  }
  Some((page, cp))
}

/// Remove o que a impressora interpretaria como comando.
///
/// Tudo que é C0 (0x00-0x1F) vira nada, menos `\n` que é quebra de linha de
/// verdade e `\t` que vira espaço (a coluna desalinhava o cardápio). O 0x7F
/// também sai. As letras vizinhas ficam: `\x1dV` é GS + "V", e descartar o V
/// junto esconderia texto do garçom sem ganhar nada.
///
/// Roda antes de tudo, inclusive do QR: um nome de item com `\x1d` injetaria
/// comandos ESC/POS e o cupom sairia cortado no meio.
pub fn sanitize(s: &str) -> String {
  if !s.bytes().any(|c| c < 0x20 || c == 0x7f) {
    return s.to_string();
  }
  let mut out = String::with_capacity(s.len());
  for r in s.chars() {
    match r {
      '\n' => out.push('\n'),
      '\t' => out.push(' '),
      r if (r as u32) < 0x20 || r as u32 == 0x7f => {}
      r => out.push(r),
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cp850_da_os_bytes_exatos_dos_acentos() {
    // Espelha TestEncodeCP850 do Go (hardening_test.go:252).
    let got = encode("cp850", "ÇçÃãÕõÁáÉéÍíÓóÚúÂâÊêÔôÀà");
    let want: Vec<u8> = vec![
      0x80, 0x87, 0xC7, 0xC6, 0xE5, 0xE4, 0xB5, 0xA0, 0x90, 0x82, 0xD6, 0xA1, 0xE0, 0xA2, 0xE9,
      0xA3, 0xB6, 0x83, 0xD2, 0x88, 0xE2, 0x93, 0xB7, 0x85,
    ];
    assert_eq!(got, want);
  }

  #[test]
  fn cada_tabela_tem_128_posicoes() {
    for (nome, high) in [
      ("cp850", CP850_HIGH),
      ("cp858", CP858_HIGH),
      ("cp1252", CP1252_HIGH),
    ] {
      assert_eq!(high.chars().count(), 128, "{nome} não tem 128 posições");
    }
  }

  #[test]
  fn cp858_tem_euro_onde_cp850_nao_tem() {
    assert_eq!(encode("cp858", "€"), vec![0xD5]);
    // Em CP850 o euro cai no fallback ASCII... que também não o tem, então
    // vira "?", que é o comportamento documentado.
    assert_eq!(encode("cp850", "€"), b"?");
  }

  #[test]
  fn windows1252_usa_os_bytes_do_cp1252() {
    assert_eq!(encode("windows-1252", "Çã€"), vec![0xC7, 0xE3, 0x80]);
    assert_eq!(code_page("windows-1252"), 16);
    assert_eq!(code_page("cp858"), 19);
    assert_eq!(code_page("cp850"), 2);
  }

  #[test]
  fn fallback_ascii_e_desconhecido() {
    assert_eq!(encode("cp850", "a–b “x”"), b"a-b \"x\"");
    assert_eq!(encode("cp850", "日"), b"?");
  }

  #[test]
  fn sanitize_tira_comando_e_mantem_texto() {
    // O caso que motivou o módulo: ESC/GS do texto do garçom não podem
    // chegar à impressora.
    let s = sanitize("Cacha\u{1b}d\u{1b}");
    assert!(!s.contains('\u{1b}'), "ESC sobreviveu: {s:?}");
    assert_eq!(s, "Cachad");

    // \n é quebra de linha de verdade; \t vira espaço (a coluna desalinhava).
    assert_eq!(sanitize("a\nb\tc"), "a\nb c");
    assert_eq!(sanitize("sem\u{7f}controle"), "semcontrole");
  }

  #[test]
  fn resolve_devolve_none_para_utf8() {
    assert_eq!(resolve(Some("utf-8"), None), None);
    assert_eq!(resolve(Some("utf8"), None), None);
    assert_eq!(resolve(None, None), Some(("cp850", 2)));
    assert_eq!(
      resolve(Some("CP850"), None),
      Some(("cp850", 2)),
      "case-insensitive"
    );
    assert_eq!(
      resolve(Some("  cp850  "), None),
      Some(("cp850", 2)),
      "espaço tolerado"
    );
    assert_eq!(
      resolve(None, Some(19)),
      Some(("cp850", 19)),
      "code_page sobrepõe"
    );
    assert_eq!(
      resolve(None, Some(999)),
      Some(("cp850", 2)),
      "fora de 0-255 é ignorado"
    );
  }
}
