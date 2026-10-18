mod components;
mod model;
mod styles;

use std::io::{self, IsTerminal, stdout};
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Cell, List, ListItem, Paragraph, Row, Table};
use model::App;
use styles::*;

pub fn run_tui() {
    if !stdout().is_terminal() {
        println!("TUI só funciona em terminal interativo");
        return;
    }
    let _ = enable_raw_mode();
    let mut stdout = stdout();
    let _ = execute!(stdout, EnterAlternateScreen);
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(_) => {
            let _ = disable_raw_mode();
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            return;
        }
    };
    let mut app = App::new();
    let _ = run_app(&mut terminal, &mut app);
    let _ = disable_raw_mode();
    let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
}

fn run_app<B: Backend>(terminal: &mut Terminal<B>, app: &mut App) -> io::Result<()> {
    loop {
        terminal.draw(|f| ui(f, app))?;
        if let Ok(Event::Key(key)) = event::read() {
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                KeyCode::Up | KeyCode::Char('k') => app.move_up(),
                KeyCode::Down | KeyCode::Char('j') => app.move_down(),
                KeyCode::Char('g') => app.selected = 0,
                KeyCode::Char('G') => app.selected = app.menu_items.len().saturating_sub(1),
                KeyCode::Char('r') => { app.loading = true; app.refresh_services(); },
                KeyCode::Enter => {},
                _ => {}
            }
        } else {
            return Ok(());
        }
    }
}

fn ui(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(f.area());
    let menu_block = Block::default().borders(Borders::ALL).title("Navegação");
    let content_block = Block::default().borders(Borders::ALL).title("Status dos Serviços");
    f.render_widget(menu_block, chunks[0]);
    f.render_widget(content_block, chunks[1]);

    let menu_items: Vec<ListItem> = app.menu_items.iter().enumerate().map(|(i, item)| {
        let style = if i == app.selected { Style::default().fg(COLOR_PRIMARY).bold() } else { Style::default() };
        ListItem::new(item.as_str()).style(style)
    }).collect();
    let menu_list = List::new(menu_items).block(Block::default().borders(Borders::NONE));
    f.render_widget(menu_list, chunks[0].inner(Margin { vertical: 1, horizontal: 1 }));

    if app.loading && app.services.is_empty() {
        let p = Paragraph::new("Carregando...").block(Block::default().borders(Borders::NONE));
        f.render_widget(p, chunks[1].inner(Margin { vertical: 1, horizontal: 1 }));
        return;
    }
    if app.services.is_empty() {
        let p = Paragraph::new("Nenhum container encontrado").block(Block::default().borders(Borders::NONE));
        f.render_widget(p, chunks[1].inner(Margin { vertical: 1, horizontal: 1 }));
        return;
    }
    let header = Row::new(vec!["Container", "Status", "Saúde", "Portas"]).style(Style::default().bold());
    let rows: Vec<Row> = app.services.iter().map(|s| {
        let health_style = match s.health.as_str() {
            "healthy" => Style::default().fg(COLOR_SUCCESS),
            "unhealthy" => Style::default().fg(COLOR_ERROR),
            "starting" => Style::default().fg(COLOR_WARNING),
            _ => Style::default().fg(COLOR_MUTED),
        };
        let state_style = match s.state.as_str() {
            "running" => Style::default().fg(COLOR_SUCCESS),
            "restarting" => Style::default().fg(COLOR_WARNING),
            "exited" | "paused" | "dead" => Style::default().fg(COLOR_ERROR),
            _ => Style::default().fg(COLOR_MUTED),
        };
        Row::new(vec![
            Cell::from(s.name.clone()),
            Cell::from(s.state.clone()).style(state_style),
            Cell::from(s.health.clone()).style(health_style),
            Cell::from(s.ports.clone()),
        ])
    }).collect();
    let table = Table::new(rows, [Constraint::Percentage(25), Constraint::Percentage(15), Constraint::Percentage(15), Constraint::Percentage(45)])
        .header(header)
        .block(Block::default().borders(Borders::NONE));
    f.render_widget(table, chunks[1].inner(Margin { vertical: 1, horizontal: 1 }));
}
