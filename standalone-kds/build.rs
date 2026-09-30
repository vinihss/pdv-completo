// Igual ao do app v1 e ao que o `tauri_build` exige de todo app Tauri: é este
// passo que lê o `tauri.conf.json`, resolve e valida as capabilities, e deixa o
// `Context` pronto para o `generate_context!` embater no binário. Sem `build()`
// aqui, o `generate_context!` do `src/lib.rs` nem compila.
fn main() {
  tauri_build::build()
}
