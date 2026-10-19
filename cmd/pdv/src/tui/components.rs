//! Componentes de renderização (ratatui) da TUI.

use ratatui::prelude::*;
use ratatui::widgets::{
  Block, BorderType, Borders, Cell, List, ListItem, Paragraph, Row, Table, Wrap,
};

use crate::tui::model::{App, Screen};
use crate::tui::styles::*;

/// Bloco padrão com bordas arredondadas e título.
pub fn panel(title_text: &str) -> Block<'static> {
  Block::default()
    .borders(Borders::ALL)
    .border_type(BorderType::Rounded)
    .border_style(Style::default().fg(SUBTLE))
    .title(Span::styled(format!(" {title_text} "), title()))
}

// ============================================================
// LAYOUT
// ============================================================

pub fn render_menu(f: &mut Frame, area: Rect, app: &App) {
  let items: Vec<ListItem> = app
    .menu
    .iter()
    .enumerate()
    .map(|(i, item)| {
      let selected = i == app.selected;
      let cursor = if selected { ICON_CURSOR } else { " " };
      let style = if selected {
        menu_selected()
      } else {
        Style::default().fg(FOREGROUND)
      };
      ListItem::new(Line::from(vec![
        Span::styled(format!("{cursor} "), style),
        Span::styled(item.label, style),
      ]))
    })
    .collect();

  let block = panel("Navegação");
  let inner = block.inner(area);
  f.render_widget(block, area);

  let chunks = Layout::default()
    .direction(Direction::Vertical)
    .constraints([Constraint::Min(1), Constraint::Length(3)])
    .split(inner);

  f.render_widget(List::new(items), chunks[0]);

  let desc = app
    .menu
    .get(app.selected)
    .map(|m| m.description)
    .unwrap_or("");
  f.render_widget(
    Paragraph::new(Line::from(Span::styled(format!("{desc}"), muted())))
      .block(
        Block::default()
          .borders(Borders::TOP)
          .border_type(BorderType::Rounded)
          .border_style(Style::default().fg(SUBTLE)),
      )
      .wrap(Wrap { trim: true }),
    chunks[1],
  );
}

pub fn render_content(f: &mut Frame, area: Rect, app: &App) {
  match app.screen {
    Screen::Services => render_services(f, area, app),
    Screen::Tenants => render_tenant_list(f, area, app, "Tenants cadastrados"),
    Screen::Picker => render_tenant_list(f, area, app, "Selecione um tenant"),
    Screen::Detail => render_detail(f, area, app),
    Screen::Form => render_form(f, area, app),
    Screen::Confirm => render_confirm(f, area, app),
    Screen::Submenu => render_submenu(f, area, app),
    Screen::Logs => render_logs(f, area, app),
    Screen::Output => render_output(f, area, app),
  }
}

pub fn render_status(f: &mut Frame, area: Rect, app: &App) {
  let (icon, color) = match app.status_kind {
    crate::tui::model::StatusKind::Info => (ICON_INFO, INFO),
    crate::tui::model::StatusKind::Success => (ICON_SUCCESS, SUCCESS),
    crate::tui::model::StatusKind::Warning => (ICON_WARNING, WARNING),
    crate::tui::model::StatusKind::Error => (ICON_ERROR, ERROR),
  };
  let prefix = if app.busy { "⏳ " } else { "" };
  let line = Line::from(vec![
    Span::raw(" "),
    Span::styled(format!("{prefix}{icon} "), Style::default().fg(color)),
    Span::styled(app.status.clone(), Style::default().fg(color)),
  ]);
  f.render_widget(Paragraph::new(line), area);
}

// ============================================================
// PAINÉIS
// ============================================================

fn render_services(f: &mut Frame, area: Rect, app: &App) {
  let block = panel("Status dos Serviços");
  let inner = block.inner(area);
  f.render_widget(block, area);

  if app.services.is_empty() {
    let msg = if app.busy {
      "Carregando containers…"
    } else {
      "Nenhum container encontrado (docker indisponível ou stack parada) — r recarrega"
    };
    f.render_widget(
      Paragraph::new(msg).style(muted()).wrap(Wrap { trim: true }),
      inner,
    );
    return;
  }

  let header = Row::new(vec!["Container", "Status", "Saúde", "Portas"])
    .style(Style::default().fg(SECONDARY).add_modifier(Modifier::BOLD));

  let rows: Vec<Row> = app
    .services
    .iter()
    .map(|s| {
      let state_style = match s.state.as_str() {
        "running" => Style::default().fg(SUCCESS),
        "restarting" => Style::default().fg(WARNING),
        "exited" | "paused" | "dead" => Style::default().fg(ERROR),
        _ => Style::default().fg(MUTED),
      };
      let health_style = match s.health.as_str() {
        "healthy" => Style::default().fg(SUCCESS),
        "unhealthy" => Style::default().fg(ERROR),
        "starting" => Style::default().fg(WARNING),
        _ => Style::default().fg(MUTED),
      };
      Row::new(vec![
        Cell::from(s.name.clone()).style(Style::default().fg(FOREGROUND)),
        Cell::from(s.state.clone()).style(state_style),
        Cell::from(s.health.clone()).style(health_style),
        Cell::from(s.ports.clone()).style(muted()),
      ])
    })
    .collect();

  let table = Table::new(
    rows,
    [
      Constraint::Percentage(30),
      Constraint::Percentage(15),
      Constraint::Percentage(15),
      Constraint::Percentage(40),
    ],
  )
  .header(header);
  f.render_widget(table, inner);
}

fn render_tenant_list(f: &mut Frame, area: Rect, app: &App, title: &str) {
  let block = panel(title);
  let inner = block.inner(area);
  f.render_widget(block, area);

  if app.tenants.is_empty() {
    let msg = if app.busy {
      "Carregando tenants…".to_string()
    } else {
      "Nenhum tenant encontrado — provisione um em 'Adicionar novo tenant'".to_string()
    };
    f.render_widget(
      Paragraph::new(msg).style(muted()).wrap(Wrap { trim: true }),
      inner,
    );
    return;
  }

  let header = Row::new(vec!["Tenant", "Slug", "Domínio", "Status", "Criado em"])
    .style(Style::default().fg(SECONDARY).add_modifier(Modifier::BOLD));

  let rows: Vec<Row> = app
    .tenants
    .iter()
    .enumerate()
    .map(|(i, t)| {
      let selected = i == app.tenant_idx;
      let base = if selected {
        menu_selected()
      } else {
        Style::default().fg(FOREGROUND)
      };
      let cursor = if selected {
        format!("{ICON_CURSOR} ")
      } else {
        "  ".to_string()
      };
      Row::new(vec![
        Cell::from(format!("{cursor}{}", t.display_name)).style(base),
        Cell::from(t.slug.clone()).style(base),
        Cell::from(if t.custom_domain.is_empty() {
          "—".to_string()
        } else {
          t.custom_domain.clone()
        })
        .style(muted()),
        Cell::from(format!(
          "{} {}",
          tenant_status_icon(&t.status),
          tenant_status_pt(&t.status)
        ))
        .style(tenant_status_style(&t.status)),
        Cell::from(t.created_at.clone()).style(muted()),
      ])
    })
    .collect();

  let table = Table::new(
    rows,
    [
      Constraint::Percentage(28),
      Constraint::Percentage(18),
      Constraint::Percentage(20),
      Constraint::Percentage(14),
      Constraint::Percentage(20),
    ],
  )
  .header(header);
  f.render_widget(table, inner);
}

fn render_detail(f: &mut Frame, area: Rect, app: &App) {
  let block = panel("Detalhes do tenant");
  let inner = block.inner(area);
  f.render_widget(block, area);

  let Some(t) = &app.selected_tenant else {
    f.render_widget(
      Paragraph::new("Nenhum tenant selecionado").style(muted()),
      inner,
    );
    return;
  };

  let mut lines: Vec<Line> = Vec::new();
  lines.push(Line::from(Span::styled(
    t.display_name.clone(),
    Style::default().fg(FOREGROUND).add_modifier(Modifier::BOLD),
  )));
  lines.push(Line::from(""));
  let kv = |name: &str, value: String, style: Style| {
    Line::from(vec![
      Span::styled(format!("  {name:<14}"), label()),
      Span::styled(value, style),
    ])
  };
  lines.push(kv("Slug:", t.slug.clone(), value()));
  lines.push(kv("Schema:", t.schema_name.clone(), value()));
  lines.push(kv(
    "Domínio:",
    if t.custom_domain.is_empty() {
      "—".into()
    } else {
      t.custom_domain.clone()
    },
    value(),
  ));
  lines.push(kv(
    "Status:",
    format!(
      "{} {}",
      tenant_status_icon(&t.status),
      tenant_status_pt(&t.status)
    ),
    tenant_status_style(&t.status),
  ));
  lines.push(kv("Criado em:", t.created_at.clone(), value()));
  lines.push(Line::from(""));
  lines.push(Line::from(Span::styled("Ações disponíveis", title())));
  lines.push(action_line("s", "Editar configurações da loja"));
  lines.push(action_line("d", "Backup/dump do tenant"));
  lines.push(action_line("u", "Adicionar usuário"));
  lines.push(Line::from(""));
  lines.push(Line::from(Span::styled("Esc volta à lista", muted())));

  f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn action_line(key: &str, desc: &str) -> Line<'static> {
  Line::from(vec![
    Span::raw("  "),
    Span::styled(format!("[{key}] "), help_key()),
    Span::styled(desc.to_string(), muted()),
  ])
}

fn render_form(f: &mut Frame, area: Rect, app: &App) {
  let title = match app.form_kind {
    crate::tui::model::FormKind::AddTenant => "Adicionar novo tenant",
    crate::tui::model::FormKind::ResetPin => "Reset PIN do manager",
    crate::tui::model::FormKind::EditConfig => "Editar configurações da loja",
    crate::tui::model::FormKind::AddUser => "Adicionar usuário",
  };
  let block = panel(title);
  let inner = block.inner(area);
  f.render_widget(block, area);

  let mut lines: Vec<Line> = Vec::new();
  lines.push(Line::from(""));
  for (i, field) in app.form.fields.iter().enumerate() {
    let active = i == app.form.active;
    let marker = if active { ICON_CURSOR } else { " " };
    let label_style = if active { selected_field() } else { label() };
    lines.push(Line::from(vec![
      Span::raw("  "),
      Span::styled(format!("{marker} {:<24}", field.label), label_style),
    ]));
    let shown = if field.value.is_empty() && !active {
      field.placeholder.clone()
    } else {
      field.value.clone()
    };
    let val_style = if field.value.is_empty() && !active {
      muted()
    } else {
      value()
    };
    let cursor = if active { "▏" } else { "" };
    lines.push(Line::from(vec![
      Span::raw("      "),
      Span::styled(format!("{shown}{cursor}"), val_style),
    ]));
    lines.push(Line::from(""));
  }
  lines.push(Line::from(Span::styled(
    "  Tab/↑↓ alterna campos · Enter confirma · Esc cancela",
    muted(),
  )));

  f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_confirm(f: &mut Frame, area: Rect, app: &App) {
  let block = panel("Confirmação");
  let inner = block.inner(area);
  f.render_widget(block, area);

  let mut lines: Vec<Line> = Vec::new();
  lines.push(Line::from(""));
  for l in app.confirm_text().lines() {
    lines.push(Line::from(Span::styled(format!("  {l}"), value())));
  }
  lines.push(Line::from(""));
  lines.push(Line::from(vec![
    Span::raw("  "),
    Span::styled("[y] ", help_key()),
    Span::styled("confirmar", muted()),
    Span::raw("   "),
    Span::styled("[n] ", help_key()),
    Span::styled("cancelar", muted()),
  ]));
  f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_submenu(f: &mut Frame, area: Rect, app: &App) {
  let block = panel(app.submenu_title());
  let inner = block.inner(area);
  f.render_widget(block, area);

  let items: Vec<ListItem> = app
    .submenu_items()
    .iter()
    .enumerate()
    .map(|(i, label)| {
      let selected = i == app.submenu_idx;
      let cursor = if selected { ICON_CURSOR } else { " " };
      let style = if selected {
        menu_selected()
      } else {
        Style::default().fg(FOREGROUND)
      };
      ListItem::new(Line::from(vec![
        Span::raw(" "),
        Span::styled(format!("{cursor} "), style),
        Span::styled(*label, style),
      ]))
    })
    .collect();

  // Deixa uma linha em branco no topo e o rodapé de ajuda embaixo.
  let chunks = Layout::default()
    .direction(Direction::Vertical)
    .constraints([
      Constraint::Length(1),
      Constraint::Min(1),
      Constraint::Length(1),
    ])
    .split(inner);
  f.render_widget(List::new(items), chunks[1]);
  f.render_widget(
    Paragraph::new(Line::from(Span::styled(
      "  ↑↓ navega · Enter executa · Esc volta",
      muted(),
    ))),
    chunks[2],
  );
}

fn render_logs(f: &mut Frame, area: Rect, app: &App) {
  let block = panel("Logs do backend");
  let inner = block.inner(area);
  f.render_widget(block, area);

  if app.logs.is_empty() {
    f.render_widget(
      Paragraph::new("Sem linhas de log — r recarrega").style(muted()),
      inner,
    );
    return;
  }
  let visible = inner.height as usize;
  let start = app.logs_scroll.min(app.logs.len().saturating_sub(1));
  let end = (start + visible).min(app.logs.len());
  let lines: Vec<Line> = app.logs[start..end]
    .iter()
    .map(|l| Line::from(Span::styled(l.clone(), Style::default().fg(FOREGROUND))))
    .collect();
  f.render_widget(Paragraph::new(lines), inner);

  // Indicador de posição no rodapé do bloco.
  let pos = format!("linhas {}-{} de {} ", start + 1, end, app.logs.len());
  let width = inner.width as usize;
  if width > pos.len() {
    let x = inner.x + (width - pos.len()) as u16;
    let y = inner.y + inner.height.saturating_sub(1);
    f.render_widget(
      Paragraph::new(Span::styled(pos.clone(), muted())),
      Rect {
        x,
        y,
        width: pos.len() as u16,
        height: 1,
      },
    );
  }
}

fn render_output(f: &mut Frame, area: Rect, app: &App) {
  let title = if app.output_title.is_empty() {
    "Saída"
  } else {
    &app.output_title
  };
  let block = panel(title);
  let inner = block.inner(area);
  f.render_widget(block, area);

  let visible = inner.height as usize;
  let start = app.output_scroll.min(app.output.len().saturating_sub(1));
  let end = (start + visible).min(app.output.len());
  let lines: Vec<Line> = app.output[start..end]
    .iter()
    .map(|l| Line::from(Span::styled(l.clone(), Style::default().fg(FOREGROUND))))
    .collect();
  f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}
