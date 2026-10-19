//! Tema visual da TUI — paleta harmônica (inspirada no tema Charm) e ícones
//! Unicode, portados da CLI Go para manter a mesma identidade.

use ratatui::style::{Color, Modifier, Style};

// ============================================================
// PALETA
// ============================================================
pub const PRIMARY: Color = Color::Rgb(0x7C, 0x3A, 0xED); // roxo vibrante
pub const SECONDARY: Color = Color::Rgb(0x06, 0xB6, 0xD4); // ciano
pub const SUCCESS: Color = Color::Rgb(0x10, 0xB9, 0x81); // verde esmeralda
pub const ERROR: Color = Color::Rgb(0xEF, 0x44, 0x44); // vermelho
pub const WARNING: Color = Color::Rgb(0xF5, 0x9E, 0x0B); // âmbar
pub const INFO: Color = Color::Rgb(0x3B, 0x82, 0xF6); // azul
pub const FOREGROUND: Color = Color::Rgb(0xFA, 0xFA, 0xFA);
pub const MUTED: Color = Color::Rgb(0x6B, 0x72, 0x80);
pub const SUBTLE: Color = Color::Rgb(0x4B, 0x55, 0x63);

// ============================================================
// ÍCONES
// ============================================================
pub const ICON_ACTIVE: &str = "●";
pub const ICON_SUSPENDED: &str = "◌";
pub const ICON_INACTIVE: &str = "✗";
pub const ICON_UNKNOWN: &str = "?";
pub const ICON_SUCCESS: &str = "✓";
pub const ICON_ERROR: &str = "✗";
pub const ICON_WARNING: &str = "⚠";
pub const ICON_INFO: &str = "ℹ";
pub const ICON_CURSOR: &str = "▸";

// ============================================================
// ESTILOS
// ============================================================
pub fn menu_selected() -> Style {
  Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD)
}

pub fn title() -> Style {
  Style::default().fg(SECONDARY).add_modifier(Modifier::BOLD)
}

pub fn muted() -> Style {
  Style::default().fg(MUTED)
}

pub fn help_key() -> Style {
  Style::default().fg(SECONDARY).add_modifier(Modifier::BOLD)
}

pub fn label() -> Style {
  Style::default().fg(MUTED)
}

pub fn value() -> Style {
  Style::default().fg(FOREGROUND)
}

pub fn selected_field() -> Style {
  Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD)
}

/// Cor/ícone para o status de um tenant (`active`/`suspended`).
pub fn tenant_status_style(status: &str) -> Style {
  match status {
    "active" => Style::default().fg(SUCCESS),
    "suspended" => Style::default().fg(WARNING),
    "inactive" => Style::default().fg(ERROR),
    _ => Style::default().fg(MUTED),
  }
}

pub fn tenant_status_icon(status: &str) -> &'static str {
  match status {
    "active" => ICON_ACTIVE,
    "suspended" => ICON_SUSPENDED,
    "inactive" => ICON_INACTIVE,
    _ => ICON_UNKNOWN,
  }
}

pub fn tenant_status_pt(status: &str) -> String {
  match status {
    "active" => "ativo".to_string(),
    "suspended" => "suspenso".to_string(),
    "inactive" => "inativo".to_string(),
    other => other.to_string(),
  }
}
