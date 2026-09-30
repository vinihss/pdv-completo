//! App **Frente de Caixa** (`com.pdvapp.caixa`) da família standalone.
//!
//! Não confunda com o app em produção `com.pdvapp.desktop`, que vive em
//! `frontend/src-tauri` e continua no repo, em produção, em transição. Os dois
//! coexistem na mesma loja durante a troca: por isso o `productName`, o
//! `identifier` e o endpoint de update deste app são todos distintos — se
//! dividissem o endpoint, o caixa e o app antigo publicariam no mesmo
//! `latest.json` e um consumiria o update do outro.
//!
//! ## O que mora aqui e o que mora no `pdv-shared`
//!
//! Aqui: o ciclo de vida do app, o `tauri.conf.json`, as capabilities e o
//! módulo [`printing`] — **este é o único app da família que imprime**, e é o
//! único motivo de `printing/` existir. `escpos` monta os bytes, `spooler`
//! entrega na fila do Windows, `status` pergunta ao aparelho e `transport`
//! manda por TCP.
//!
//! No `pdv-shared` (crate `pdv_shared`): o `app.json` por instalação e os 3
//! commands de config, mais o registro comum de plugins. Duas decisões que
//! moram lá e que valem saber de memória:
//!
//! - **A config fica FORA do diretório de instalação** (`%APPDATA%\PDV\app.json`,
//!   com `%ProgramData%` como padrão de máquina). O auto-update substitui os
//!   arquivos do diretório de instalação a cada versão, então config dentro dele
//!   seria sobrescrita — e a loja perderia a URL do backend e as impressoras.
//! - **O HTTP do app vai pelo Rust** (`tauri-plugin-http`), nunca por `fetch`
//!   no webview: o app roda na origem `tauri.localhost` e o backend libera CORS
//!   só para o domínio configurado, então o `fetch` seria bloqueado pelo
//!   navegador do app. No web (PWA) continua sendo `fetch` normal.
//!
//! Os 3 commands de config são registrados aqui por caminho de crate
//! (`pdv_shared::app_config`): o `#[tauri::command]` do shared exporta o
//! wrapper `__cmd__*` com a visibilidade da função, e é assim que
//! `tauri::generate_handler!` resolve um command definido em outro crate.

pub mod printing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // `pdv_shared::builder` registra `http`, `process` e `updater` (o preset
  // desktop do `Plugins::default`) e liga o `tauri-plugin-log` em debug. Não
  // registramos plugin nenhum aqui: o que é comum aos 4 apps é do shared, e
  // duplicar a cadeia aqui é como o app v1 e o novo divergem sem ninguém ver.
  pdv_shared::builder(tauri::Builder::default())
    .invoke_handler(tauri::generate_handler![
      // Config por instalação (compartilhada — mesmas assinaturas nos 4 apps).
      pdv_shared::app_config,
      pdv_shared::save_app_config,
      pdv_shared::reset_app_config,
      // Impressão: o que é deste app.
      printing::commands::printer_list,
      printing::commands::printer_status,
      printing::commands::printer_test,
      printing::commands::print_ticket
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
