use crate::ops::{list_services, Service};

pub struct App {
    pub selected: usize,
    pub menu_items: Vec<String>,
    pub services: Vec<Service>,
    pub loading: bool,
}

impl App {
    pub fn new() -> Self {
        let mut app = Self {
            selected: 0,
            menu_items: vec![
                "Listar tenants".to_string(),
                "Adicionar novo tenant".to_string(),
                "Setup".to_string(),
                "Status dos serviços".to_string(),
                "Aplicar seeds".to_string(),
                "Visualizar logs".to_string(),
                "Reset PIN do manager".to_string(),
                "Editar configurações".to_string(),
                "Backup/dump do tenant".to_string(),
            ],
            services: vec![],
            loading: true,
        };
        app.refresh_services();
        app
    }
    pub fn move_up(&mut self) {
        if self.selected > 0 { self.selected -= 1; }
    }
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.menu_items.len() { self.selected += 1; }
    }
    pub fn refresh_services(&mut self) {
        self.services = list_services().unwrap_or_default();
        self.loading = false;
    }
}
