//! PDV Garçom — o app móvel do garçom.
//!
//! O app que o garçom carrega no bolso: abre comanda, lança itens, entrega e
//! fecha conta. É o segundo app mobile da família (com o Entregador) e o que
//! mais depende de WebSocket: o `useRealtime` do frontend é o que mantém a
//! comanda sincronizada com a cozinha e o caixa em tempo real.
//!
//! ## O que vem do `pdv_shared`
//!
//! Só duas coisas: os 3 commands de config (`app_config`, `save_app_config`,
//! `reset_app_config`) e o registro de plugins ([`pdv_shared::Plugins`]).
//!
//! A config por instalação é compartilhada de propósito, e não por economia:
//! `app.json` é **um arquivo só**, e um garçom e um caixa na mesma máquina
//! leem o mesmo. É por isso que [`pdv_shared::AppConfig`] tem `printers` mesmo
//! num app que não imprime — o daemon é do `standalone-pdv`, e o garçom não
//! precisa de um `AppConfig` paralelo só para "não ter impressora". Se um dia
//! o `app.json` ficar específico por app, a decisão é do shared, não daqui.
//!
//! ## O que este app não tem, e por quê
//!
//! As três ausências são decisão, não esquecimento — e cada uma delas muda o
//! que o `tauri.conf.json` e o `capabilities/` precisam declarar:
//!
//!   - **Impressão.** Sem `externalBin`, sem `installer-hooks.nsh`, sem módulo
//!     `printing`. O hook do instalador do app v1 é o que registra o daemon
//!     como serviço do Windows, e aqui não há sidecar para registrar — copiar a
//!     referência faria o instalador procurar um executável que não existe.
//!     Quem manda o ticket para a fila é o `standalone-pdv`, na máquina do
//!     caixa.
//!   - **Updater.** Sem bloco `plugins.updater` e sem `createUpdaterArtifacts`
//!     (juntar as duas coisas é erro de config, não ócio: sem updater
//!     registrado, pedir artefato de update faz o build procurar uma chave que
//!     ninguém configurou). O app do garçom é distribuído por loja (APK/iOS),
//!     não por `latest.json` — a loja é quem valida e assina o binário.
//!   - **Commands próprios.** O `invoke_handler` abaixo tem três entradas, e
//!     todas são do shared. Registrar command de app aqui que não é usado é a
//!     forma mais barata de aumentar superfície sem precisar.
//!
//! ## O `tauri.conf.json` é JSON puro
//!
//! Ele não aceita comentário, então o `frontendDist`, o `devUrl` e o porquê do
//! `cd frontend` nos hooks ficam explicados aqui e não lá. Vale o registro
//! porque o Garçom é o app da família que mais depende do diretório apontado
//! existir: `frontendDist` é `../frontend/dist/garcon`, e o `generate_context!`
//! abaixo embate esses arquivos no binário **no momento do build**. Buildar sem
//! `npm run build:garcon` rodado antes no `frontend` não dá warning — dá erro.
//!
//! ## Onde o hook roda (e por que o comando é `cd frontend && ...`)
//!
//! O hook **não** roda no diretório do crate. A CLI resolve um "frontend dir" e
//! executa o `beforeBuildCommand`/`beforeDevCommand` de lá
//! (`helpers::run_hook`: `cwd = script_cwd || frontend_dir`). Invocada de
//! `standalone-garcon/` — que é de onde se roda `cargo tauri build` — a resolução
//! não acha `package.json` nem ali nem abaixo, e cai no fallback
//! `tauri.parent()`: a raiz do repo. Daí o `cd frontend`. O mesmo comando
//! serve para os 4 apps, porque os quatro são pastas irmãs de `frontend/`.
//!
//! Dois cuidados que a mesma resolução implica:
//!
//!   - **Rode a CLI de dentro do crate.** Da raiz do repo ela não acha este
//!     crate: a busca por `tauri.conf.json` desce no máximo 3 níveis e a
//!     primeira partida é o app v1, em `frontend/src-tauri` — ou seja, o
//!     comando pode buildar o app errado sem reclamar.
//!   - Em dev, o `beforeDevCommand` sobe `npm run dev`, que é o profile `all`
//!     (o app inteiro, com as 4 telas) e não a entry do garçom. O `frontend`
//!     não tem um `dev:garcon` e esta fase não mexe nele.
//!
//! ## Mobile (Android)
//!
//! O projeto Gradle fica em `gen/android/` e é **versionado** — é ele que
//! carrega o `AndroidManifest.xml`, a liberação de cleartext (o plano LOCAL do
//! produto fala `http://<ip-da-lan>`), o signing do release e a correção do
//! `BuildTask` (o template chama `node tauri`, que não resolve com o
//! `@tauri-apps/cli` deste repo). O passo a passo de build, os requisitos
//! (compileSdk 36, NDK r30, JDK 17) e o que ainda não foi provado estão no
//! README do crate — leia lá antes de rodar `tauri android init`, que
//! regenera os arquivos por cima.
//!
/// Ponto de entrada do app — o `main.rs` só chama isto.
///
/// O `cfg_attr(mobile)` é o mesmo do app v1 e do formato canônico do Tauri:
/// sem o cfg `mobile` ele não faz nada, e com ele vira o `start_app` que o
/// projeto Android/iOS do Tauri procura. Este app é mobile, e o atributo é o
/// da família.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // `Plugins` explícito, e **não** o atalho `pdv_shared::builder()`, que é
  // `Plugins::default()` — tudo ligado, updater incluso. Chamar o atalho aqui
  // traria o auto-update de volta sem ninguém pedir, e foi justamente o que a
  // família decidiu não ter no mobile.
  //
  //   updater: false — ver o doc do módulo. O app é distribuído por loja, não
  //     por `latest.json`.
  //   process: false — ele existe para o `app.restart()` que vem logo depois
  //     que o updater instala a versão nova (ver `plugins.rs` do shared, que
  //     diz que os dois flags saem juntos). Sem updater não há quem o chame, e
  //     plugin registrado sem permission correspondente é só ruído: o
  //     `capabilities/default.json` daqui não concede `process:allow-restart`
  //     justamente porque nada no bundle do garçom pede reinício.
  //   log: false — o `apply` só liga em debug, e mesmo assim gravar log em
  //     disco a cada chamada é ruído em celular e consome armazenamento. O
  //     shared recomenda `false` para os apps mobile.
  pdv_shared::Plugins {
    updater: false,
    process: false,
    log: false,
  }
  .apply(tauri::Builder::default())
  .invoke_handler(tauri::generate_handler![
    pdv_shared::app_config,
    pdv_shared::save_app_config,
    pdv_shared::reset_app_config,
  ])
  // Cross-crate funciona porque o `#[tauri::command]` do shared exporta o
  // `__cmd__*` correspondente com `#[macro_export]`, e o `generate_handler!`
  // só precisa do caminho `pdv_shared::<fn>` para achar o wrapper ao lado
  // dela (ele troca o último segmento do caminho pelo nome do wrapper).
  //
  // Duas armadilhas do ACL, ambas verificadas no build do KDS e que
  // valem para os outros três apps da família:
  //
  //   1. Este `generate_handler!` tem um filtro que remove commands não
  //      listados na ACL. Ele só liga com as DUAS chaves ligadas ao mesmo
  //      tempo: `build > removeUnusedCommands: true` no conf **e** um
  //      manifest de ACL do app (um `try_build(Attributes…)` com
  //      `app_manifest`, ou um `permissions/`). Um `build()` simples como o
  //      deste crate não gera o `allowed-commands.json`, então os três
  //      commands passam inteiros. Se alguém ligar as duas chaves, esta
  //      lista vira lista fechada e os três precisam aparecer no manifest.
  //   2. Um command de app não é o mesmo coisa que uma permission de
  //      plugin: `app_config` e companhia não precisam de entrada nenhuma no
  //      `capabilities/default.json` (é por isso que o do app v1, que os
  //      registra igual, não tem uma). O que precisa de entrada é o
  //      `http:default` — e para o ACL achar a permission, o
  //      `tauri-plugin-http` tem que ser dependência direta deste crate.
  //      Ver o comentário no Cargo.toml.
  //
  // ------------------------------------------------------------------
  // NÃO encadeie um `.setup()` aqui.
  //
  // O `Builder::setup` do Tauri **substitui** o hook anterior
  // (`self.setup = Box::new(setup)`, tauri-2.12 `src/app.rs`) — ele não
  // acumula. O `Plugins::apply` acima já ocupa esse slot para registrar o
  // `tauri-plugin-log`. Um segundo `.setup()` não rodaria os dois: ele
  // apagaria o log plugin em silêncio, e o sintoma apareceria só em build
  // debug, no `warn` de config corrompida que ninguém lê. Se precisar
  // colocar algo no boot, o lugar é dentro do shared ou em um `build.rs` com
  // `try_build`.
  // ------------------------------------------------------------------
  .run(tauri::generate_context!())
  .expect("error while running tauri application");
}
