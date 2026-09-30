//! App **Entregador** (`com.pdvapp.entregador`) da família standalone.
//!
//! O primeiro mobile dos quatro apps (PDV, KDS, Garçom, Entregador). Abre
//! `frontend/dist/entregador/` (o profile `entregador` do Vite) e roda a tela
//! de rota do entregador: lista de entregas pendentes, dispatch, confirmação
//! de entrega e falha.
//!
//! ## O que vem do `pdv_shared`
//!
//! Só duas coisas: os 3 commands de config (`app_config`, `save_app_config`,
//! `reset_app_config`) e o registro de plugins ([`pdv_shared::Plugins`]).
//!
//! A config por instalação é compartilhada de propósito: `app.json` é **um
//! arquivo só**, e o entregador e o caixa na mesma máquina leem o mesmo. É por
//! isso que [`pdv_shared::AppConfig`] tem `printers` mesmo num app que não
//! imprime — o daemon é do `standalone-pdv`, e o entregador não precisa de um
//! `AppConfig` paralelo só para "não ter impressora".
//!
//! ## O que este app não tem, e por quê
//!
//! As três ausências são decisão, não esquecimento:
//!
//!   - **Updater.** Sem bloco `plugins.updater` e sem `createUpdaterArtifacts`.
//!     A distribuição é por loja/APK: quem instala é a Play Store, não um
//!     `latest.json`, então o updater não teria onde buscar versão nova.
//!   - **Process.** O `process` existe para o `app.restart()` que vem logo
//!     depois que o updater instala (ver `plugins.rs` do shared). Sem updater
//!     não há quem o chame.
//!   - **Log em arquivo.** O `Plugins::apply` só liga o `tauri-plugin-log` em
//!     build debug, e mesmo assim grava em disco — em celular isso é ruído e
//!     consumo de armazenamento. O entregador roda em release na loja, então
//!     `log: false`.
//!
//! ## O `tauri.conf.json` é JSON puro
//!
//! Ele não aceita comentário, então o `frontendDist`, o `devUrl` e o porquê do
//! `cd frontend` nos hooks ficam explicados aqui e não lá. Vale o registro
//! porque o `frontendDist` é `../frontend/dist/entregador`, e o
//! `generate_context!` abaixo embate esses arquivos no binário **no momento do
//! build**. Buildar sem `npm run build:entregador` rodado antes no `frontend`
//! não dá warning — dá erro.
//!
//! ## Onde o hook roda (e por que o comando é `cd frontend && ...`)
//!
//! O hook **não** roda no diretório do crate. A CLI resolve um "frontend dir" e
//! executa o `beforeBuildCommand`/`beforeDevCommand` de lá
//! (`helpers::run_hook`: `cwd = script_cwd || frontend_dir`). Invocada de
//! `standalone-entregador/` — que é de onde se roda `cargo tauri build` — a
//! resolução não acha `package.json` nem ali nem abaixo, e cai no fallback
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
//!     (o app inteiro, com as 4 telas) e não a entry do entregador. O
//!     `frontend` não tem um `dev:entregador` e esta fase não mexe nele.
//!
//! ## Mobile: o que falta (e por que não está aqui)
//!
//! Este é o único app da família cujo caso de uso pede **GPS e permissões de
//! sistema do mobile** (localização em background, notificação de pedido).
//! Isso vive em `gen/android/app/src/main/AndroidManifest.xml`, que é **gerado**
//! pelo `tauri android init` — ou seja, não existe ainda. Ver o README deste
//! crate para a lista precisa do que declarar lá.
//!
//! O `$schema` de `capabilities/default.json` aponta para
//! `../gen/schemas/desktop-schema.json`, que é gerado pelo `build.rs` no host.
//! O schema mobile (`mobile-schema.json`) só existe depois do `tauri android
//! init` — até lá o `$schema` aponta para um arquivo que não existe, e isso é
//! esperado.

/// Ponto de entrada do app — o `main.rs` só chama isto.
///
/// O `cfg_attr(mobile)` é o mesmo do app v1 e do formato canônico do Tauri:
/// sem o cfg `mobile` ele não faz nada, e com ele vira o `start_app` que o
/// projeto Android/iOS do Tauri procura.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // `Plugins` explícito, e **não** o atalho `pdv_shared::builder()`, que é
  // `Plugins::default()` — tudo ligado, updater incluso. Chamar o atalho aqui
  // traria o auto-update de volta sem ninguém pedir, e foi justamente o que a
  // família decidiu não ter no entregador.
  //
  //   updater: false — ver o doc do módulo.
  //   process: false — sem updater não há quem chame `app.restart()`.
  //   log: false — em mobile, log em arquivo é ruído e consumo de armazenamento.
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
  // Duas armadilhas do ACL, ambas verificadas no build do `standalone-kds` e
  // que valem para os outros três apps da família:
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
  // `tauri-plugin-log` (mesmo que `log: false` o slot está ocupado). Um
  // segundo `.setup()` não rodaria os dois: ele apagaria o hook do shared
  // em silêncio. Se precisar colocar algo no boot, o lugar é dentro do
  // shared ou em um `build.rs` com `try_build`.
  // ------------------------------------------------------------------
  .run(tauri::generate_context!())
  .expect("error while running tauri application");
}
