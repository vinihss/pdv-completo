// Igual aos demais apps: lê `tauri.conf.json`, valida capabilities e
// prepara o `Context` usado por `tauri::generate_context!()`.
fn main() {
  tauri_build::build()
}
