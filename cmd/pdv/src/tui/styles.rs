use ratatui::style::{Color, Style};

pub const COLOR_PRIMARY: Color = Color::Cyan;
pub const COLOR_SUCCESS: Color = Color::Green;
pub const COLOR_WARNING: Color = Color::Yellow;
pub const COLOR_ERROR: Color = Color::Red;
pub const COLOR_MUTED: Color = Color::Gray;

pub fn menu_selected() -> Style {
    Style::default().fg(COLOR_PRIMARY)
}
