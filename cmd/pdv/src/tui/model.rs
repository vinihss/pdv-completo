//! Estado e regras de interação da TUI (padrão "uma tela por vez" no painel
//! direito, com o menu fixo à esquerda).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::ops::{self, SeedInfo, Service, StoreSettings, TenantInfo};

// ============================================================
// MENU
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
  ListTenants,
  AddTenant,
  Setup,
  Services,
  Seeds,
  Logs,
  ResetPin,
  EditConfig,
  Dump,
}

pub struct MenuItem {
  pub label: &'static str,
  pub description: &'static str,
  pub action: Action,
}

pub fn menu_items() -> Vec<MenuItem> {
  vec![
    MenuItem {
      label: "Listar tenants",
      description: "ver todos os tenants cadastrados",
      action: Action::ListTenants,
    },
    MenuItem {
      label: "Adicionar novo tenant",
      description: "provisionar schema + migrations",
      action: Action::AddTenant,
    },
    MenuItem {
      label: "Setup",
      description: "dependências, .env, migrations e seeds",
      action: Action::Setup,
    },
    MenuItem {
      label: "Status dos serviços",
      description: "health dos containers Docker",
      action: Action::Services,
    },
    MenuItem {
      label: "Aplicar seeds",
      description: "catálogo de seeds do backend",
      action: Action::Seeds,
    },
    MenuItem {
      label: "Visualizar logs",
      description: "logs do backend",
      action: Action::Logs,
    },
    MenuItem {
      label: "Reset PIN do manager",
      description: "redefinir acesso de um tenant",
      action: Action::ResetPin,
    },
    MenuItem {
      label: "Editar configurações",
      description: "ajustar store_settings",
      action: Action::EditConfig,
    },
    MenuItem {
      label: "Backup/dump do tenant",
      description: "exportar schema para SQL",
      action: Action::Dump,
    },
  ]
}

// ============================================================
// TELAS
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
  Services,
  Tenants,
  Detail,
  Picker,
  Form,
  Confirm,
  Submenu,
  Logs,
  Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormKind {
  AddTenant,
  ResetPin,
  EditConfig,
  AddUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmenuKind {
  Setup,
  Seeds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
  ResetPin,
  EditConfig,
  Dump,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
  Info,
  Success,
  Warning,
  Error,
}

#[derive(Debug, Clone)]
pub enum ConfirmKind {
  CreateTenant { slug: String, name: String },
  Dump { slug: String, tenant_id: String },
  ApplySeed { id: String, title: String },
}

// ============================================================
// FORMULÁRIOS
// ============================================================

pub struct Field {
  pub label: String,
  pub value: String,
  pub placeholder: String,
}

impl Field {
  fn text(label: &str, value: &str, placeholder: &str) -> Self {
    Self {
      label: label.into(),
      value: value.into(),
      placeholder: placeholder.into(),
    }
  }
  fn boolean(label: &str, value: bool) -> Self {
    Self {
      label: label.into(),
      value: bool_str(value).into(),
      placeholder: "true/false".into(),
    }
  }
}

pub struct Form {
  pub fields: Vec<Field>,
  pub active: usize,
}

impl Form {
  fn value(&self, i: usize) -> String {
    self
      .fields
      .get(i)
      .map(|f| f.value.trim().to_string())
      .unwrap_or_default()
  }
  fn next(&mut self) {
    if self.active + 1 < self.fields.len() {
      self.active += 1;
    }
  }
  fn prev(&mut self) {
    if self.active > 0 {
      self.active -= 1;
    }
  }
  fn push(&mut self, c: char) {
    if let Some(f) = self.fields.get_mut(self.active) {
      f.value.push(c);
    }
  }
  fn backspace(&mut self) {
    if let Some(f) = self.fields.get_mut(self.active) {
      f.value.pop();
    }
  }
  fn clear(&mut self) {
    if let Some(f) = self.fields.get_mut(self.active) {
      f.value.clear();
    }
  }
}

fn bool_str(b: bool) -> String {
  if b {
    "true".into()
  } else {
    "false".into()
  }
}

/// Interpreta um booleano em texto (pt/en).
fn parse_bool(s: &str) -> Option<bool> {
  match s.trim().to_ascii_lowercase().as_str() {
    "true" | "1" | "sim" | "s" | "yes" | "y" => Some(true),
    "false" | "0" | "nao" | "não" | "n" | "no" => Some(false),
    _ => None,
  }
}

// ============================================================
// JOBS (executados fora do draw loop)
// ============================================================

pub enum Job {
  LoadTenants,
  LoadServices,
  LoadLogs,
  LoadSeeds,
  LoadSettings {
    /// Id do tenant (uuid) — o contexto que a policy de RLS compara com a
    /// coluna `tenant_id`. Sem ele a sessão não vê linha nenhuma da loja.
    tenant_id: Option<String>,
    slug: String,
  },
  CreateTenant {
    slug: String,
    name: String,
  },
  ResetPin {
    slug: String,
    pin: String,
  },
  AddUser {
    slug: String,
    name: String,
    profile: String,
    pin: String,
  },
  SaveSettings {
    /// Id do tenant (uuid) — o contexto da policy de RLS (ver `LoadSettings`).
    tenant_id: Option<String>,
    slug: String,
    settings: StoreSettings,
  },
  Dump {
    slug: String,
    /// Id do tenant (uuid) — o export é por `tenant_id` (o dump por schema
    /// morreu com o RLS: o `pg_dump` não respeita a policy).
    tenant_id: String,
  },
  SetupDeps,
  SetupEnv,
  Migrate,
  ApplySeed {
    id: String,
  },
  SetupFull,
}

pub enum JobResult {
  Tenants(Result<Vec<TenantInfo>, String>),
  Services(Result<Vec<Service>, String>),
  Logs(Result<Vec<String>, String>),
  Seeds(Result<Vec<SeedInfo>, String>),
  Settings {
    slug: String,
    /// Id do tenant (uuid) — o contexto que a policy de RLS exige (ver
    /// `Job::LoadSettings`).
    tenant_id: Option<String>,
    result: Result<StoreSettings, String>,
  },
  Task {
    title: String,
    ok: bool,
    output: String,
  },
}

/// Executa um job (chamadas bloqueantes a `ops`). Chamado fora do draw loop.
pub fn run_job(job: Job) -> JobResult {
  match job {
    Job::LoadTenants => JobResult::Tenants(ops::list_tenants()),
    Job::LoadServices => JobResult::Services(ops::list_services().map_err(|e| e.to_string())),
    Job::LoadLogs => JobResult::Logs(ops::backend_logs(300)),
    Job::LoadSeeds => JobResult::Seeds(ops::list_seeds()),
    Job::LoadSettings { slug, tenant_id } => {
      let result = ops::get_store_settings(tenant_id.as_deref());
      JobResult::Settings {
        slug,
        tenant_id,
        result,
      }
    }
    Job::CreateTenant { slug, name } => {
      let res = ops::create_tenant(&slug, &name);
      task_result(format!("Provisionar tenant '{slug}'"), res)
    }
    Job::ResetPin { slug, pin } => {
      let res = ops::reset_manager_pin(&slug, &pin);
      task_result(format!("Reset de PIN do manager ({slug})"), res)
    }
    Job::AddUser {
      slug,
      name,
      profile,
      pin,
    } => {
      let res = ops::add_user(&slug, &name, &profile, &pin);
      task_result(format!("Adicionar usuário ({slug})"), res)
    }
    Job::SaveSettings {
      slug,
      tenant_id,
      settings,
    } => {
      let res = ops::update_store_settings(tenant_id.as_deref(), &settings)
        .map(|_| format!("store_settings atualizado ({slug})."));
      task_result(format!("Salvar configurações ({slug})"), res)
    }
    Job::Dump { slug, tenant_id } => {
      let out_file = format!("/tmp/tenant-{slug}-dump.sql");
      let res = ops::dump_tenant(&tenant_id, &out_file).map(|_| format!("Dump salvo em {out_file}"));
      task_result(format!("Backup/dump do tenant '{slug}'"), res)
    }
    Job::SetupDeps => {
      let (ok, out) = ops::install_dependencies();
      JobResult::Task {
        title: "Instalar dependências".into(),
        ok,
        output: out,
      }
    }
    Job::SetupEnv => {
      let (ok, out) = ops::ensure_backend_env();
      JobResult::Task {
        title: "Configurar .env".into(),
        ok,
        output: out,
      }
    }
    Job::Migrate => {
      let (code, out) = ops::npm_backend("db:migrate");
      JobResult::Task {
        title: "Rodar migrations".into(),
        ok: code == 0,
        output: out,
      }
    }
    Job::ApplySeed { id } => {
      let res = ops::apply_seed(&id);
      task_result(format!("Aplicar seed '{id}'"), res)
    }
    Job::SetupFull => {
      let (ok, out) = ops::setup_full();
      JobResult::Task {
        title: "Setup completo".into(),
        ok,
        output: out,
      }
    }
  }
}

fn task_result(title: String, res: Result<String, String>) -> JobResult {
  match res {
    Ok(out) => JobResult::Task {
      title,
      ok: true,
      output: out,
    },
    Err(err) => JobResult::Task {
      title,
      ok: false,
      output: err,
    },
  }
}

// ============================================================
// APP
// ============================================================

pub struct App {
  pub menu: Vec<MenuItem>,
  pub selected: usize,

  pub screen: Screen,
  pub tenants: Vec<TenantInfo>,
  pub tenant_idx: usize,
  pub selected_tenant: Option<TenantInfo>,
  pub services: Vec<Service>,
  pub logs: Vec<String>,
  pub logs_scroll: usize,

  /// Catálogo de seeds — lido do manifest do backend em runtime (seed novo
  /// aparece na TUI sem recompilar a CLI).
  pub seeds: Vec<SeedInfo>,
  /// Verdadeiro quando o catálogo foi carregado com sucesso.
  pub seeds_loaded: bool,
  /// Último erro ao ler o catálogo (manifest ausente/inválido).
  pub seeds_error: Option<String>,

  pub form: Form,
  pub form_kind: FormKind,
  pub active_slug: String,
  pub active_schema: String,
  /// Id do tenant ativo (uuid) — o contexto que a policy de RLS exige.
  pub active_tenant_id: Option<String>,

  pub submenu: SubmenuKind,
  pub submenu_idx: usize,
  pub pending: Pending,

  pub confirm: Option<ConfirmKind>,
  pub confirm_back: Screen,

  pub output_title: String,
  pub output: Vec<String>,
  pub output_scroll: usize,
  /// Tela para onde o painel de Output volta (Esc/Enter).
  pub output_back: Screen,

  pub status: String,
  pub status_kind: StatusKind,

  pub job: Option<Job>,
  pub busy: bool,
  pub should_quit: bool,
}

impl App {
  pub fn new() -> Self {
    let menu = menu_items();
    // Índice do item "Status dos serviços" — o painel inicial.
    let selected = menu
      .iter()
      .position(|m| m.action == Action::Services)
      .unwrap_or(0);
    let mut app = Self {
      menu,
      selected,
      screen: Screen::Services,
      tenants: Vec::new(),
      tenant_idx: 0,
      selected_tenant: None,
      services: Vec::new(),
      logs: Vec::new(),
      logs_scroll: 0,
      seeds: Vec::new(),
      seeds_loaded: false,
      seeds_error: None,
      form: Form {
        fields: Vec::new(),
        active: 0,
      },
      form_kind: FormKind::AddTenant,
      active_slug: String::new(),
      active_schema: String::new(),
      active_tenant_id: None,
      submenu: SubmenuKind::Setup,
      submenu_idx: 0,
      pending: Pending::ResetPin,
      confirm: None,
      confirm_back: Screen::Services,
      output_title: String::new(),
      output: Vec::new(),
      output_scroll: 0,
      output_back: Screen::Services,
      status: "Carregando status dos serviços…".into(),
      status_kind: StatusKind::Info,
      job: None,
      busy: true,
      should_quit: false,
    };
    app.screen = Screen::Services;
    app.request(Job::LoadServices, "Carregando status dos serviços…");
    app
  }

  fn request(&mut self, job: Job, msg: &str) {
    self.job = Some(job);
    self.busy = true;
    // Padrão: o painel de Output volta para o painel inicial.
    self.output_back = Screen::Services;
    self.set_status(msg, StatusKind::Info);
  }

  /// Pede um job que, ao terminar, devolve o usuário para `back` em vez do
  /// painel inicial (aplicar um seed volta para a lista de seeds).
  fn request_from(&mut self, job: Job, msg: &str, back: Screen) {
    self.request(job, msg);
    self.output_back = back;
  }

  fn set_status(&mut self, msg: impl Into<String>, kind: StatusKind) {
    self.status = msg.into();
    self.status_kind = kind;
  }

  pub fn apply(&mut self, result: JobResult) {
    self.busy = false;
    match result {
      JobResult::Tenants(Ok(tenants)) => {
        self.tenants = tenants;
        if self.tenant_idx >= self.tenants.len() {
          self.tenant_idx = 0;
        }
        let n = self.tenants.len();
        self.set_status(format!("{n} tenant(s) carregado(s)"), StatusKind::Success);
      }
      JobResult::Tenants(Err(e)) => {
        self.set_status(format!("Erro ao listar tenants: {e}"), StatusKind::Error)
      }
      JobResult::Services(Ok(services)) => {
        let n = services.len();
        self.services = services;
        self.set_status(
          format!("{n} container(s)"),
          if n > 0 {
            StatusKind::Success
          } else {
            StatusKind::Warning
          },
        );
      }
      JobResult::Services(Err(e)) => {
        self.services.clear();
        self.set_status(format!("Erro ao ler serviços: {e}"), StatusKind::Error);
      }
      JobResult::Logs(Ok(lines)) => {
        self.logs = lines;
        self.logs_scroll = 0;
        self.screen = Screen::Logs;
        self.set_status(
          "Logs do backend carregados (r recarrega)",
          StatusKind::Success,
        );
      }
      JobResult::Logs(Err(e)) => {
        self.screen = Screen::Output;
        self.output_title = "Logs do backend".into();
        self.output = e.lines().map(|l| l.to_string()).collect();
        self.output_scroll = 0;
        self.set_status("Falha ao ler os logs", StatusKind::Error);
      }
      JobResult::Seeds(Ok(seeds)) => {
        self.seeds = seeds;
        self.seeds_loaded = true;
        self.seeds_error = None;
        if self.submenu_idx >= self.seeds.len() {
          self.submenu_idx = 0;
        }
        let n = self.seeds.len();
        self.set_status(format!("{n} seed(s) no catálogo"), StatusKind::Success);
      }
      JobResult::Seeds(Err(e)) => {
        self.seeds.clear();
        self.seeds_loaded = false;
        self.seeds_error = Some(e.clone());
        self.set_status(format!("Erro ao carregar seeds: {e}"), StatusKind::Error);
      }
      JobResult::Settings {
        slug,
        tenant_id,
        result,
      } => {
        self.active_slug = slug.clone();
        self.active_tenant_id = tenant_id.clone();
        match result {
          Ok(s) => {
            self.form = Form {
              fields: vec![
                Field::text("Nome do comerciante", &s.merchant_name, "ex: Umami Sushi"),
                Field::text("Cidade", &s.merchant_city, "ex: Sao Paulo"),
                Field::boolean("Impressão habilitada", s.printer_enabled),
                Field::boolean("Impressão automática", s.printer_auto_print),
                Field::boolean("Entrega habilitada", s.uses_delivery),
              ],
              active: 0,
            };
            self.form_kind = FormKind::EditConfig;
            self.screen = Screen::Form;
            self.set_status(
              format!("Configurações de '{slug}' (schema {})", self.active_schema),
              StatusKind::Info,
            );
          }
          Err(e) => {
            self.screen = Screen::Output;
            self.output_title = format!("Configurações — {slug}");
            self.output = e.lines().map(|l| l.to_string()).collect();
            self.output_scroll = 0;
            self.set_status("Falha ao carregar configurações", StatusKind::Error);
          }
        }
      }
      JobResult::Task { title, ok, output } => {
        self.output_title = title.clone();
        self.output = if output.trim().is_empty() {
          vec![format!(
            "{title}: {}",
            if ok { "concluído" } else { "falhou" }
          )]
        } else {
          output.lines().map(|l| l.to_string()).collect()
        };
        self.output_scroll = 0;
        self.screen = Screen::Output;
        if ok {
          self.set_status(format!("{title}: concluído"), StatusKind::Success);
        } else {
          self.set_status(format!("{title}: falhou — veja a saída"), StatusKind::Error);
        }
      }
    }
  }

  // ========================================================
  // TECLADO
  // ========================================================

  pub fn on_key(&mut self, key: KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    if ctrl && key.code == KeyCode::Char('c') {
      self.should_quit = true;
      return;
    }
    // `q` só sai fora de formulários (onde `q` é digitável).
    if key.code == KeyCode::Char('q') && self.screen != Screen::Form {
      self.should_quit = true;
      return;
    }

    match self.screen {
      Screen::Services => self.key_services(key),
      Screen::Tenants => self.key_list(key),
      Screen::Detail => self.key_detail(key),
      Screen::Picker => self.key_picker(key),
      Screen::Form => self.key_form(key),
      Screen::Confirm => self.key_confirm(key),
      Screen::Submenu => self.key_submenu(key),
      Screen::Logs => self.key_logs(key),
      Screen::Output => self.key_output(key),
    }
  }

  fn key_services(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Esc => self.back_to_services(),
      KeyCode::Char('r') => self.request(Job::LoadServices, "Recarregando serviços…"),
      KeyCode::Up | KeyCode::Char('k') => self.move_menu(-1),
      KeyCode::Down | KeyCode::Char('j') => self.move_menu(1),
      KeyCode::Char('g') => self.selected = 0,
      KeyCode::Char('G') => self.selected = self.menu.len().saturating_sub(1),
      KeyCode::Enter => self.open_menu(),
      _ => {}
    }
  }

  fn key_logs(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Esc => self.back_to_services(),
      KeyCode::Char('r') => self.request(Job::LoadLogs, "Recarregando logs…"),
      KeyCode::Up | KeyCode::Char('k') => self.logs_scroll = self.logs_scroll.saturating_sub(1),
      KeyCode::Down | KeyCode::Char('j') => self.logs_scroll = self.logs_scroll.saturating_add(1),
      KeyCode::PageUp => self.logs_scroll = self.logs_scroll.saturating_sub(10),
      KeyCode::PageDown => self.logs_scroll = self.logs_scroll.saturating_add(10),
      _ => {}
    }
  }

  fn key_output(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Esc | KeyCode::Enter => self.back_from_output(),
      KeyCode::Up | KeyCode::Char('k') => self.output_scroll = self.output_scroll.saturating_sub(1),
      KeyCode::Down | KeyCode::Char('j') => {
        self.output_scroll = self.output_scroll.saturating_add(1)
      }
      KeyCode::PageUp => self.output_scroll = self.output_scroll.saturating_sub(10),
      KeyCode::PageDown => self.output_scroll = self.output_scroll.saturating_add(10),
      _ => {}
    }
  }

  fn key_submenu(&mut self, key: KeyEvent) {
    let len = self.submenu_items().len();
    match key.code {
      KeyCode::Esc => self.back_to_services(),
      KeyCode::Char('r') => self.request(Job::LoadSeeds, "Recarregando catálogo de seeds…"),
      KeyCode::Up | KeyCode::Char('k') => self.submenu_idx = self.submenu_idx.saturating_sub(1),
      KeyCode::Down | KeyCode::Char('j') => {
        if self.submenu_idx + 1 < len {
          self.submenu_idx += 1;
        }
      }
      KeyCode::Char('g') => self.submenu_idx = 0,
      KeyCode::Char('G') => self.submenu_idx = len.saturating_sub(1),
      KeyCode::Enter => self.run_submenu(),
      _ => {}
    }
  }

  fn key_list(&mut self, key: KeyEvent) {
    let len = self.tenants.len();
    match key.code {
      KeyCode::Esc => self.back_to_services(),
      KeyCode::Char('r') => self.request(Job::LoadTenants, "Atualizando lista de tenants…"),
      KeyCode::Up | KeyCode::Char('k') => self.tenant_idx = self.tenant_idx.saturating_sub(1),
      KeyCode::Down | KeyCode::Char('j') => {
        if self.tenant_idx + 1 < len {
          self.tenant_idx += 1;
        }
      }
      KeyCode::Char('g') => self.tenant_idx = 0,
      KeyCode::Char('G') => self.tenant_idx = len.saturating_sub(1),
      KeyCode::Enter => self.open_tenant_detail(),
      _ => {}
    }
  }

  fn key_picker(&mut self, key: KeyEvent) {
    let len = self.tenants.len();
    match key.code {
      KeyCode::Esc => self.back_to_services(),
      KeyCode::Char('r') => self.request(Job::LoadTenants, "Atualizando lista de tenants…"),
      KeyCode::Up | KeyCode::Char('k') => self.tenant_idx = self.tenant_idx.saturating_sub(1),
      KeyCode::Down | KeyCode::Char('j') => {
        if self.tenant_idx + 1 < len {
          self.tenant_idx += 1;
        }
      }
      KeyCode::Char('g') => self.tenant_idx = 0,
      KeyCode::Char('G') => self.tenant_idx = len.saturating_sub(1),
      KeyCode::Enter => self.picker_select(),
      _ => {}
    }
  }

  fn key_detail(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Esc | KeyCode::Char('h') => {
        self.selected_tenant = None;
        self.screen = Screen::Tenants;
      }
      KeyCode::Char('s') => self.open_settings_for_selected(),
      KeyCode::Char('d') => self.confirm_dump_for_selected(),
      KeyCode::Char('u') => self.open_add_user_form(),
      _ => {}
    }
  }

  fn key_form(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Esc => {
        self.set_status("Operação cancelada", StatusKind::Info);
        self.back_after_form_cancel();
      }
      KeyCode::Tab | KeyCode::Down => self.form.next(),
      KeyCode::BackTab | KeyCode::Up => self.form.prev(),
      KeyCode::Enter => self.submit_form(),
      KeyCode::Backspace => self.form.backspace(),
      KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => self.form.clear(),
      KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => self.form.push(c),
      _ => {}
    }
  }

  fn key_confirm(&mut self, key: KeyEvent) {
    match key.code {
      KeyCode::Char('y') | KeyCode::Char('s') => self.run_confirm(),
      KeyCode::Char('n') | KeyCode::Esc => {
        self.confirm = None;
        self.screen = self.confirm_back;
        self.set_status("Cancelado", StatusKind::Info);
      }
      _ => {}
    }
  }

  // ========================================================
  // NAVEGAÇÃO / AÇÕES
  // ========================================================

  fn move_menu(&mut self, delta: i32) {
    let len = self.menu.len() as i32;
    let next = (self.selected as i32 + delta).clamp(0, len - 1);
    self.selected = next as usize;
  }

  fn back_to_services(&mut self) {
    self.selected_tenant = None;
    self.confirm = None;
    self.screen = Screen::Services;
    self.busy = false;
    // Sincroniza o cursor do menu com o painel padrão.
    if let Some(i) = self.menu.iter().position(|m| m.action == Action::Services) {
      self.selected = i;
    }
  }

  /// Volta do painel de Output para a tela de origem: o submenu que disparou
  /// a tarefa (aplicar seed) ou o painel inicial (demais tarefas).
  fn back_from_output(&mut self) {
    match self.output_back {
      Screen::Submenu => {
        self.confirm = None;
        self.screen = Screen::Submenu;
        self.busy = false;
      }
      _ => self.back_to_services(),
    }
  }

  fn open_menu(&mut self) {
    let action = self.menu[self.selected].action;
    match action {
      Action::Services => self.request(Job::LoadServices, "Carregando status dos serviços…"),
      Action::ListTenants => {
        self.screen = Screen::Tenants;
        self.request(Job::LoadTenants, "Carregando tenants…");
      }
      Action::AddTenant => {
        self.form = Form {
          fields: vec![
            Field::text("Slug (identificador)", "", "ex: umami-sushi"),
            Field::text("Nome de exibição", "", "ex: Umami Sushi Arte"),
          ],
          active: 0,
        };
        self.form_kind = FormKind::AddTenant;
        self.screen = Screen::Form;
        self.set_status(
          "Informe slug e nome (Tab alterna, Enter confirma)",
          StatusKind::Info,
        );
      }
      Action::Setup => {
        self.submenu = SubmenuKind::Setup;
        self.submenu_idx = 0;
        self.screen = Screen::Submenu;
        // O item "aplicar seed de demonstração" depende do catálogo.
        self.request(Job::LoadSeeds, "Carregando catálogo de seeds…");
      }
      Action::Seeds => {
        self.submenu = SubmenuKind::Seeds;
        self.submenu_idx = 0;
        self.screen = Screen::Submenu;
        self.request(Job::LoadSeeds, "Carregando seeds…");
      }
      Action::Logs => self.request(Job::LoadLogs, "Carregando logs do backend…"),
      Action::ResetPin => {
        self.open_picker(Pending::ResetPin, "Selecione o tenant para resetar o PIN")
      }
      Action::EditConfig => self.open_picker(
        Pending::EditConfig,
        "Selecione o tenant para editar configurações",
      ),
      Action::Dump => self.open_picker(Pending::Dump, "Selecione o tenant para backup/dump"),
    }
  }

  fn open_picker(&mut self, pending: Pending, msg: &str) {
    self.pending = pending;
    self.screen = Screen::Picker;
    self.request(Job::LoadTenants, msg);
  }

  fn open_tenant_detail(&mut self) {
    if let Some(t) = self.tenants.get(self.tenant_idx).cloned() {
      self.selected_tenant = Some(t);
      self.screen = Screen::Detail;
      self.set_status(
        "s configurações · d backup/dump · u adicionar usuário",
        StatusKind::Info,
      );
    }
  }

  fn picker_select(&mut self) {
    let Some(t) = self.tenants.get(self.tenant_idx).cloned() else {
      self.set_status("Nenhum tenant na lista", StatusKind::Warning);
      return;
    };
    self.selected_tenant = Some(t.clone());
    match self.pending {
      Pending::ResetPin => {
        self.active_slug = t.slug.clone();
        self.form = Form {
          fields: vec![Field::text("PIN (4–6 dígitos)", "", "vazio gera aleatório")],
          active: 0,
        };
        self.form_kind = FormKind::ResetPin;
        self.screen = Screen::Form;
        self.set_status(
          format!("Reset do PIN do manager de '{}'", t.slug),
          StatusKind::Info,
        );
      }
      Pending::EditConfig => {
        self.request(
          Job::LoadSettings {
            slug: t.slug.clone(),
            tenant_id: Some(t.id.clone()),
          },
          "Carregando configurações…",
        );
      }
      Pending::Dump => {
        self.confirm = Some(ConfirmKind::Dump {
          slug: t.slug.clone(),
          tenant_id: t.id.clone(),
        });
        self.confirm_back = Screen::Picker;
        self.screen = Screen::Confirm;
      }
    }
  }

  fn open_settings_for_selected(&mut self) {
    if let Some(t) = self.selected_tenant.clone() {
      self.request(
        Job::LoadSettings {
          slug: t.slug.clone(),
          tenant_id: Some(t.id.clone()),
        },
        "Carregando configurações…",
      );
    }
  }

  fn confirm_dump_for_selected(&mut self) {
    if let Some(t) = self.selected_tenant.clone() {
      self.confirm = Some(ConfirmKind::Dump {
        slug: t.slug.clone(),
        tenant_id: t.id.clone(),
      });
      self.confirm_back = Screen::Detail;
      self.screen = Screen::Confirm;
    }
  }

  fn open_add_user_form(&mut self) {
    if let Some(t) = self.selected_tenant.clone() {
      self.active_slug = t.slug.clone();
      self.form = Form {
        fields: vec![
          Field::text("Nome do usuário", "", "ex: João Silva"),
          Field::text("Perfil", "", "waiter/kitchen/manager/cashier/courier"),
          Field::text("PIN (4–6 dígitos)", "", "vazio gera aleatório"),
        ],
        active: 0,
      };
      self.form_kind = FormKind::AddUser;
      self.screen = Screen::Form;
      self.set_status(
        format!("Adicionar usuário em '{}'", t.slug),
        StatusKind::Info,
      );
    }
  }

  fn back_after_form_cancel(&mut self) {
    match self.form_kind {
      FormKind::AddUser => {
        self.screen = if self.selected_tenant.is_some() {
          Screen::Detail
        } else {
          Screen::Services
        };
      }
      FormKind::EditConfig => {
        self.screen = if self.selected_tenant.is_some() {
          Screen::Detail
        } else {
          Screen::Services
        };
      }
      _ => self.back_to_services(),
    }
  }

  // ========================================================
  // SUBMENUS
  // ========================================================

  pub fn submenu_title(&self) -> &'static str {
    match self.submenu {
      SubmenuKind::Setup => "Setup",
      SubmenuKind::Seeds => "Aplicar seeds",
    }
  }

  /// Itens do submenu atual. Os de Setup são fixos; os de seeds vêm do
  /// catálogo lido do manifest do backend (runtime).
  pub fn submenu_items(&self) -> Vec<String> {
    match self.submenu {
      SubmenuKind::Setup => vec![
        "Instalar dependências".into(),
        "Configurar .env".into(),
        "Rodar migrations".into(),
        self.setup_seed_label(),
        "Setup completo".into(),
      ],
      SubmenuKind::Seeds => self.seeds.iter().map(seed_label).collect(),
    }
  }

  /// Rótulo do item "aplicar seed" do Setup — o seed de demonstração do
  /// catálogo (`demo`, o mesmo que o `pdv setup` roda).
  fn setup_seed_label(&self) -> String {
    match self.demo_seed() {
      Some(seed) if seed.id == "demo" => "Aplicar seed de demonstração (demo)".into(),
      Some(seed) => format!("Aplicar seed de demonstração (fallback: {})", seed.id),
      None => "Aplicar seed de demonstração (catálogo indisponível)".into(),
    }
  }

  /// Seed selecionado na lista de seeds.
  pub fn selected_seed(&self) -> Option<&SeedInfo> {
    self.seeds.get(self.submenu_idx)
  }

  /// Seed de demonstração do catálogo (`demo`); sem ele, o primeiro disponível.
  pub fn demo_seed(&self) -> Option<&SeedInfo> {
    self
      .seeds
      .iter()
      .find(|s| s.id == "demo")
      .or_else(|| self.seeds.first())
  }

  fn run_submenu(&mut self) {
    match self.submenu {
      SubmenuKind::Setup => match self.submenu_idx {
        0 => self.request(Job::SetupDeps, "Instalando dependências…"),
        1 => self.request(Job::SetupEnv, "Configurando .env…"),
        2 => self.request(Job::Migrate, "Rodando migrations…"),
        3 => self.run_demo_seed(),
        4 => self.request(Job::SetupFull, "Executando setup completo…"),
        _ => {}
      },
      SubmenuKind::Seeds => self.run_selected_seed(),
    }
  }

  /// Aplica o seed de demonstração (`demo`) do catálogo. Sem `demo`, cai no
  /// primeiro seed disponível — e avisa o usuário da troca.
  fn run_demo_seed(&mut self) {
    let Some(seed) = self.demo_seed().cloned() else {
      self.set_status(
        "Catálogo de seeds indisponível — aperte r para recarregar (ou rode `pdv db seeds`)",
        StatusKind::Error,
      );
      return;
    };
    let note = if seed.id == "demo" {
      None
    } else {
      Some(format!("o catálogo não tem 'demo' — usando '{}'", seed.id))
    };
    self.start_apply(&seed, note.as_deref());
  }

  /// Aplica o seed selecionado na lista.
  fn run_selected_seed(&mut self) {
    let Some(seed) = self.selected_seed().cloned() else {
      let msg = if self.seeds_error.is_some() {
        "Não há catálogo carregado — aperte r para recarregar"
      } else if !self.seeds_loaded {
        "Carregando o catálogo de seeds…"
      } else {
        "Nenhum seed selecionado"
      };
      self.set_status(msg, StatusKind::Warning);
      return;
    };
    self.start_apply(&seed, None);
  }

  /// Inicia a aplicação de um seed: os destrutivos passam pela confirmação.
  fn start_apply(&mut self, seed: &SeedInfo, note: Option<&str>) {
    if seed.destructive {
      self.confirm = Some(ConfirmKind::ApplySeed {
        id: seed.id.clone(),
        title: seed.title.clone(),
      });
      self.confirm_back = Screen::Submenu;
      self.screen = Screen::Confirm;
      self.set_status(
        format!("'{}' é destrutivo — confirme para aplicar", seed.id),
        StatusKind::Warning,
      );
      return;
    }
    let mut msg = format!("Aplicando seed '{}'…", seed.id);
    if let Some(note) = note {
      msg = format!("{msg} ({note})");
    }
    self.request_from(
      Job::ApplySeed {
        id: seed.id.clone(),
      },
      &msg,
      Screen::Submenu,
    );
  }

  // ========================================================
  // FORMULÁRIOS: SUBMISSÃO
  // ========================================================

  fn submit_form(&mut self) {
    match self.form_kind {
      FormKind::AddTenant => {
        let slug = self.form.value(0);
        let name = self.form.value(1);
        if let Err(e) = validate_slug(&slug) {
          self.set_status(e, StatusKind::Error);
          return;
        }
        if name.is_empty() {
          self.set_status("Nome de exibição é obrigatório", StatusKind::Error);
          return;
        }
        self.confirm = Some(ConfirmKind::CreateTenant { slug, name });
        self.confirm_back = Screen::Form;
        self.screen = Screen::Confirm;
      }
      FormKind::ResetPin => {
        let pin = self.form.value(0);
        if !pin.is_empty() && !valid_pin(&pin) {
          self.set_status("PIN inválido (use 4–6 dígitos)", StatusKind::Error);
          return;
        }
        let slug = self.active_slug.clone();
        self.request(Job::ResetPin { slug, pin }, "Resetando PIN…");
      }
      FormKind::AddUser => {
        let name = self.form.value(0);
        let profile = self.form.value(1).to_ascii_lowercase();
        let pin = self.form.value(2);
        if name.is_empty() {
          self.set_status("Nome do usuário é obrigatório", StatusKind::Error);
          return;
        }
        const PROFILES: [&str; 5] = ["waiter", "kitchen", "manager", "cashier", "courier"];
        if !PROFILES.contains(&profile.as_str()) {
          self.set_status(
            "Perfil inválido (waiter/kitchen/manager/cashier/courier)",
            StatusKind::Error,
          );
          return;
        }
        if !pin.is_empty() && !valid_pin(&pin) {
          self.set_status("PIN inválido (use 4–6 dígitos)", StatusKind::Error);
          return;
        }
        let slug = self.active_slug.clone();
        self.request(
          Job::AddUser {
            slug,
            name,
            profile,
            pin,
          },
          "Adicionando usuário…",
        );
      }
      FormKind::EditConfig => {
        let merchant_name = self.form.value(0);
        if merchant_name.is_empty() {
          self.set_status("Nome do comerciante é obrigatório", StatusKind::Error);
          return;
        }
        let mut settings = StoreSettings {
          merchant_name,
          merchant_city: self.form.value(1),
          ..Default::default()
        };
        for (idx, key) in [
          (2, "Impressão habilitada"),
          (3, "Impressão automática"),
          (4, "Entrega habilitada"),
        ] {
          match parse_bool(&self.form.value(idx)) {
            Some(v) => match idx {
              2 => settings.printer_enabled = v,
              3 => settings.printer_auto_print = v,
              _ => settings.uses_delivery = v,
            },
            None => {
              self.set_status(format!("{key}: use true/false"), StatusKind::Error);
              return;
            }
          }
        }
        let slug = self.active_slug.clone();
        let tenant_id = self.active_tenant_id.clone();
        self.request(
          Job::SaveSettings {
            slug,
            tenant_id,
            settings,
          },
          "Salvando configurações…",
        );
      }
    }
  }

  fn run_confirm(&mut self) {
    // A confirmação continua visível durante o job (a tela mostra
    // "executando…"); o guarda evita disparar a ação duas vezes.
    if self.busy {
      return;
    }
    let Some(kind) = self.confirm.clone() else {
      self.screen = self.confirm_back;
      return;
    };
    match kind {
      ConfirmKind::CreateTenant { slug, name } => {
        self.request(Job::CreateTenant { slug, name }, "Provisionando tenant…");
      }
      ConfirmKind::Dump { slug, tenant_id } => {
        self.request(Job::Dump { slug, tenant_id }, "Exportando dump…");
      }
      ConfirmKind::ApplySeed { id, .. } => {
        self.request_from(Job::ApplySeed { id }, "Aplicando seed…", Screen::Submenu);
      }
    }
  }

  /// Texto da confirmação atual.
  pub fn confirm_text(&self) -> String {
    match &self.confirm {
            Some(ConfirmKind::CreateTenant { slug, name }) => format!(
                "Criar o tenant '{slug}' ({name})?\nProvisiona schema, migrations e o manager — não é reversível."
            ),
            Some(ConfirmKind::Dump { slug, .. }) => format!(
                "Fazer backup/dump do tenant '{slug}'?\nGera /tmp/tenant-{slug}-dump.sql (pg_dump --schema)."
            ),
            Some(ConfirmKind::ApplySeed { id, title }) => format!(
                "Aplicar o seed '{id}'?\n{title}\n\nEste seed é destrutivo: sobrescreve ou apaga dados existentes. Não é reversível."
            ),
            None => "Executar esta ação?".into(),
        }
  }
}

/// Rótulo canônico de um seed no catálogo ("<id> — <title>").
pub fn seed_label(seed: &SeedInfo) -> String {
  format!("{} — {}", seed.id, seed.title)
}

// ============================================================
// VALIDAÇÃO
// ============================================================

pub fn validate_slug(slug: &str) -> Result<(), String> {
  if slug.is_empty() {
    return Err("Slug é obrigatório".into());
  }
  let mut chars = slug.chars();
  let first = chars.next().unwrap();
  if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
    return Err("Slug deve começar com letra minúscula ou número".into());
  }
  if !slug
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
  {
    return Err("Slug aceita apenas letras minúsculas, números e hífen".into());
  }
  Ok(())
}

pub fn valid_pin(pin: &str) -> bool {
  (4..=6).contains(&pin.len()) && pin.chars().all(|c| c.is_ascii_digit())
}
