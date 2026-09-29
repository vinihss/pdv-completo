import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/shared/lib";

// Ponte para os comandos do Rust (`src-tauri/src/lib.rs`). No web não há
// arquivo de config: o app roda servido junto com a API e usa a origem
// atual, então tudo aqui resolve para `null`/no-op.

export async function loadAppConfig() {
  if (!isDesktop()) return null;
  return (await invoke("app_config")) ?? null;
}

export async function persistAppConfig(config) {
  return invoke("save_app_config", { config });
}

export async function clearAppConfig() {
  return invoke("reset_app_config");
}
