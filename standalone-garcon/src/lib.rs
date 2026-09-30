//! PDV Garçom — o app de bolso do garçom.
//!
//! App **mobile** (Android/iOS) da família standalone (PDV Caixa, KDS Cozinha,
//! Garçom, Entregador). Crate independente, pasta-irmã na raiz do repo: ele não
//! enxerga o app v1 em `frontend/src-tauri`, que continua no repo, em produção,
//! em transição. Nada é importado de lá para cá, nem daqui para lá.
//!
//! ## A tela não mora aqui
//!
//! Este crate não tem uma única linha de UI, e isso é o desenho, não uma
//! lacuna. O `frontendDist` aponta para `../frontend/dist/garcon` — o profile
//! `garcon` do Vite (`npm run build:garcon`), que monta o **mesmo** bundle
//! React das outras entries. O que separa o app do garçom do app do caixa não é
//! uma página, é o `<meta name="app-profile" content="garcon">` que a entry
//! `frontend/garcon.html` declara antes do bundle carregar: `main.jsx` escreve
//! esse valor em `document.documentElement.dataset.appProfile` e o roteamento
//! resolve a partir dele.
//!
//! Consequência prática, e ela é boa: **não crie uma página "garçom"** no
//! React. O `frontend/src/pages/` tem `pdv`, `cashier`, `kitchen`, `courier`,
//! `login`, `manager` — e é exatamente essa lista que serve. Um app nativo
//! que abrisse uma página nova seria a primeira tela que não existe no web, e
//! tudo que ela fizesse teria de ser escrito duas vezes.
//!
//! ## O que vem do `pdv_shared`
//!
//! Só duas coisas: os 3 commands de config (`app_config`, `save_app_config`,
//! `reset_app_config`) e o registro de plugins ([`pdv_shared::Plugins`]).
//!
//! ## O que este app não tem, e por quê
//!
//! Quatro ausências, todas decisão — e cada uma muda o que o
//! `tauri.conf.json` e o `capabilities/` precisam declarar:
//!
//!   - **Updater.** A distribuição aqui é por loja/APK, não por `latest.json`.
//!     Um auto-update que o usuário não pediu e que a loja reverte no próximo
//!     `apt-get`/`App Store` cria um estado que ninguém consegue explicar. Por
//!     isso não há bloco `plugins.updater` no conf, nem
//!     `createUpdaterArtifacts`: juntar as duas coisas é erro de config, não
//!     ócio — sem updater registrado, pedir artefato de update faz o build
//!     procurar uma chave que ninguém configurou.
//!   - **Process.** Ele existe para o `app.restart()` que vem logo depois que o
//!     updater instala a versão nova (ver `plugins.rs` do shared, que diz que
//!     os dois flags saem juntos). Sem updater não há quem chame, e na App
//!     Store reinstalar o binário do usuário não é uma operação que o app
//!     possa fazer. O plugin também não tem equivalente em mobile.
//!   - **Impressão.** Sem `externalBin`, sem `installer-hooks.nsh`, sem módulo
//!     `printing`, e sem o `windows`/spooler no Cargo.toml. Quem manda o
//!     ticket para a fila é o `standalone-pdv`, na máquina do caixa; o garçom
//!     não tem impressora nem spooler, tem uma tela e um polegar.
//!   - **Commands próprios.** O `invoke_handler` abaixo tem três entradas, e
//!     todas são do shared. Registrar command de app aqui que nada chama é a
//!     forma mais barata de aumentar superfície sem precisar.
//!
//! ## `run()` não é genérica — e em mobile isso continua certo
//!
//! A doc do [`pdv_shared::builder`] diz que ele é genérico sobre `R: Runtime`
//! "porque dois dos quatro apps rodam em Android/iOS, onde o runtime não é
//! `Wry`". Vale registrar o que a macro `#[tauri::mobile_entry_point]` faz de
//! fato, porque a dúvida é legítima e a resposta muda o código:
//!
//! O atributo expande (em `tauri-macros/src/mobile.rs`) para um `_start_app`
//! que, no Android, chama `tauri::android_binding!(…, ::tauri::wry)` — ou seja,
//! o `Wry` do Tauri 2 **é** o runtime em Android e iOS, e é ele que constrói a
//! `Builder` lá dentro. Por isso `tauri::Builder::default()` compila igual nas
//! duas plataformas e esta `run()` não precisa ser genérica. Também por isso o
//! mesmo `build.rs` com `tauri_build::build()` é obrigatório: a macro lê
//! `TAURI_ANDROID_PACKAGE_NAME_PREFIX` e `TAURI_ANDROID_PACKAGE_NAME_APP_NAME`
//! (derivadas do `identifier`) e **falha a compilação com "`env var not set,
//! do you have a build script with tauri-build?`"** sem ele.
//!
//! ## A `app.windows` existe, mas no celular não manda
//!
//! O bloco `app.windows` do conf é o que o `cargo check` do host compila (o
//! caminho desktop do crate é real e é o que roda nesta máquina). O tamanho
//! dele é o de um celular só para que o `tauri dev` no host abra algo que não
//! precise de redimensionar na mão. No Android/iOS o Tauri ignora `width` e
//! `height` e usa a tela do sistema — os botões de navegação do sistema e a
//! área de gestos é que delimitam a área útil, e o CSS do bundle é responsivo.

/// Ponto de entrada do app — o `main.rs` só chama isto.
///
/// O `cfg_attr(mobile)` é o formato canônico do Tauri: sem o cfg `mobile` ele
/// não faz nada, e com ele o atributo gera o símbolo `start_app` (o nome é
/// checado pela CLI, não renomeie) que o projeto Android/iOS procura.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // `Plugins` explícito, e **não** o atalho `pdv_shared::builder()`, que é
  // `Plugins::default()` — tudo ligado, updater incluso. Chamar o atalho aqui
  // traria o auto-update de volta num app que não tem, e ele voltaria junto
  // com o `process` e sem chave de assinatura: o build passaria e o app
  // quebraria no primeiro boot.
  //
  //   updater: false — distribuição por loja/APK, não por `latest.json`.
  //   process: false — não existe em mobile, e sem updater não há quem chame
  //     o `app.restart()` que ele existe para servir.
  //   log: false  — o `apply` só liga em build debug, e mesmo assim é o
  //     `tauri-plugin-log` gravando arquivo a cada chamada. No celular isso é
  //     ruído e consumo de armazenamento que o usuário não vai ler e não sabe
  //     apagar (o `logDir` é do app, não dele). O que substitui o log aqui é
  //     o `logcat`/`console` do sistema, que o suporte já sabe usar. Um
  //     `app.json` corrompido neste app não volta para a tela de setup como
  //     no desktop, porque o `app.json` nem é o lugar da config do garçom —
  //     ver a nota de config abaixo.
  pdv_shared::Plugins {
    updater: false,
    process: false,
    log: false,
  }
  .apply(tauri::Builder::default())
  // Só os 3 commands do shared. Cross-crate funciona porque o
  // `#[tauri::command]` do shared exporta o `__cmd__*` correspondente com
  // `#[macro_export]`, e o `generate_handler!` só precisa do caminho
  // `pdv_shared::<fn>` — ele troca o último segmento pelo nome do wrapper.
  //
  // App command **não** é permission de plugin: estes três não precisam de
  // entrada nenhuma no `capabilities/default.json` (é por isso que o do app v1,
  // que os registra igual, também não tem uma). O que precisa de entrada é o
  // `http:default` — e para o ACL achar a permission, o `tauri-plugin-http`
  // tem que ser dependência direta deste crate. Ver o comentário no
  // Cargo.toml.
  .invoke_handler(tauri::generate_handler![
    pdv_shared::app_config,
    pdv_shared::save_app_config,
    pdv_shared::reset_app_config,
  ])
  // ------------------------------------------------------------------
  // NÃO encadeie um `.setup()` aqui.
  //
  // O `Builder::setup` do Tauri **substitui** o hook anterior
  // (`self.setup = Box::new(setup)`, tauri-2.12 `src/app.rs`) — ele não
  // acumula. O `Plugins::apply` acima já ocupa esse slot. Um segundo
  // `.setup()` não rodaria os dois: ele apagaria o anterior em silêncio, e o
  // sintoma apareceria só em build debug. Se precisar colocar algo no boot, o
  // lugar é dentro do shared ou em um `build.rs` com `try_build`.
  // ------------------------------------------------------------------
  .run(tauri::generate_context!())
  .expect("error while running tauri application");
}
