mod services;

use std::process::Command;

use crate::config::root_path;

pub use services::{list_services, Service};

#[derive(Debug, Clone)]
pub struct TenantInfo {
    pub id: i32,
    pub slug: String,
    pub subdomain: String,
    pub status: String,
    pub created_at: String,
}

fn load_db_url(backend_dir: &std::path::Path) -> String {
    if let Ok(db) = std::env::var("DATABASE_URL") {
        return db;
    }
    let _ = dotenvy::from_path(backend_dir.join(".env"));
    std::env::var("DATABASE_URL").unwrap_or_default()
}

pub fn list_tenants() -> anyhow::Result<Vec<TenantInfo>> {
    let root = root_path();
    let backend_dir = root.join("backend");
    let query = "SELECT id, slug, subdomain, status, created_at::text FROM public.tenant ORDER BY created_at DESC";
    let db_url = load_db_url(&backend_dir);
    let mut c = Command::new("psql");
    c.current_dir(&backend_dir);
    c.env("DATABASE_URL", &db_url);
    c.args([&db_url, "-t", "-A", "-F", "|", "-c", query]);
    let output = c.output()?;
    if !output.status.success() {
        return Err(anyhow::anyhow!("psql falhou: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let mut res = vec![];
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() != 5 {
            continue;
        }
        if let Ok(id) = parts[0].parse::<i32>() {
            res.push(TenantInfo {
                id,
                slug: parts[1].to_string(),
                subdomain: parts[2].to_string(),
                status: parts[3].to_string(),
                created_at: parts[4].to_string(),
            });
        }
    }
    Ok(res)
}
