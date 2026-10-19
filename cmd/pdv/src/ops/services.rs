use serde::Deserialize;
use std::process::Command;

#[derive(Debug, Clone, Deserialize)]
pub struct ContainerInfo {
  #[serde(rename = "Names")]
  pub names: String,
  #[serde(rename = "State")]
  pub state: String,
  #[serde(rename = "Status")]
  pub status: String,
  #[serde(rename = "Ports")]
  pub ports: String,
}

#[derive(Debug, Clone)]
pub struct Service {
  pub name: String,
  pub state: String,
  pub health: String,
  pub ports: String,
}

pub fn list_services() -> anyhow::Result<Vec<Service>> {
  let mut cmd = Command::new("docker");
  cmd.args(["ps", "--format", "json"]);
  let output = cmd.output()?;
  if !output.status.success() {
    return Err(anyhow::anyhow!("docker ps falhou"));
  }
  let text = String::from_utf8_lossy(&output.stdout);
  let mut services: Vec<Service> = Vec::new();
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    if let Ok(c) = serde_json::from_str::<ContainerInfo>(line) {
      let name = c.names.trim_start_matches('/').to_string();
      let health = if c.status.contains("(healthy)") {
        "healthy".to_string()
      } else if c.status.contains("(unhealthy)") {
        "unhealthy".to_string()
      } else if c.status.contains("(starting)") {
        "starting".to_string()
      } else if c.status.contains("(health: starting)") {
        "starting".to_string()
      } else {
        "n/a".to_string()
      };
      services.push(Service {
        name: name.clone(),
        state: c.state.clone(),
        health,
        ports: c.ports.clone(),
      });
    }
  }
  services.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(services)
}
