mod components;
mod model;
mod styles;

use std::io::{self, stdout, IsTerminal};
use std::time::Duration;

use crossterm::{
  event::{self, Event, KeyEventKind},
  execute,
  terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::prelude::*;

use model::App;

pub fn run_tui() {
  if !stdout().is_terminal() {
    println!("TUI só funciona em terminal interativo");
    return;
  }
  if enable_raw_mode().is_err() {
    println!("TUI só funciona em terminal interativo");
    return;
  }
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
  let res = run_app(&mut terminal, &mut app);

  let _ = disable_raw_mode();
  let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
  let _ = terminal.show_cursor();

  if let Err(e) = res {
    eprintln!("erro na TUI: {e}");
  }
}

fn run_app<B: Backend>(terminal: &mut Terminal<B>, app: &mut App) -> io::Result<()> {
  loop {
    terminal.draw(|f| ui(f, app))?;

    // Jobs (chamadas bloqueantes) rodam fora do draw, depois de um frame
    // já ter mostrado "⏳ …".
    if let Some(job) = app.job.take() {
      let result = model::run_job(job);
      app.apply(result);
      continue;
    }

    if event::poll(Duration::from_millis(250))? {
      if let Event::Key(key) = event::read()? {
        if key.kind == KeyEventKind::Press {
          app.on_key(key);
        }
      }
    }

    if app.should_quit {
      return Ok(());
    }
  }
}

fn ui(f: &mut Frame, app: &App) {
  let root = f.area();
  let rows = Layout::default()
    .direction(Direction::Vertical)
    .constraints([Constraint::Min(3), Constraint::Length(1)])
    .split(root);

  let cols = Layout::default()
    .direction(Direction::Horizontal)
    .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
    .split(rows[0]);

  components::render_menu(f, cols[0], app);
  components::render_content(f, cols[1], app);
  components::render_status(f, rows[1], app);
}
