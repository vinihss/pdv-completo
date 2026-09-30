// Igual ao do app v1 e ao que o `tauri_build` exige de todo app Tauri: é este
// passo que lê o `tauri.conf.json`, resolve e valida as capabilities, e deixa o
// `Context` pronto para o `generate_context!` embater no binário. Sem `build()`
// aqui, o `generate_context!` do `src/lib.rs` nem compila.
//
// Em mobile este passo ganha duas exportações: `TAURI_ANDROID_PACKAGE_NAME_*`.
// É delas que o `#[tauri::mobile_entry_point]` tira o domínio e o nome do app
// para gerar o `android_binding!` que o projeto Gradle procura. Elas só
// existem depois do `tauri android init` (que preenche o `gen/android/`) — até
// lá o crate compila no host, onde o cfg `mobile` não liga e o macro não
// expande. Ver o README deste crate.
fn main() {
  tauri_build::build()
}
