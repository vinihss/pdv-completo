# PDV Garçom — app móvel do garçom

Crate Tauri do app **Garçom** (`com.pdvapp.garcon`) da família standalone.
É o app que o garçom carrega no bolso: abre comanda, lança itens, entrega e
fecha conta. É o segundo app mobile da família (com o Entregador) e o que
mais depende de WebSocket: o `useRealtime` do frontend é o que mantém a
comanda sincronizada com a cozinha e o caixa em tempo real.

> **Não confundir com o app em produção.** `frontend/src-tauri`
> (`com.pdvapp.desktop`, productName "PDV", v1.0.11) continua no repo, em
> produção, em transição. Os dois apps coexistem na mesma loja durante a
> troca. Por isso tudo que identifica este app é distinto: `productName`
> "PDV Garçom", `identifier` `com.pdvapp.garcon`.

## Com o que este app se divide

| Onde | O quê |
|---|---|
| `standalone-shared` (crate `pdv_shared`) | o `app.json` por instalação (`AppConfig`), os 3 commands de config e o registro comum de plugins (`Plugins`). Também o **esquema** de impressoras (`Transport`, `PrinterProfile`, `PrintersConfig`), importado e não reimplementado. |
| este crate | ciclo de vida, `tauri.conf.json`, capabilities. |

Duas decisões que moram no shared e que valem saber:

- **A config fica fora do diretório de instalação** (`%APPDATA%\PDV\app.json`,
  com `%ProgramData%` como padrão de máquina). O auto-update substitui os
  arquivos do diretório de instalação a cada versão, então config dentro dele
  seria sobrescrita e a loja perderia a URL do backend e as impressoras.
- **O HTTP vai pelo Rust** (`tauri-plugin-http`), nunca por `fetch` no webview:
  o app roda na origem `tauri.localhost` e o backend libera CORS só para o
  domínio configurado, então o `fetch` seria bloqueado pelo navegador do app.

## ACL: o plugin é dependência direta, mesmo sem registro aqui

Quem registra os plugins é `pdv_shared::Plugins`. Ainda assim
`tauri-plugin-http` está em `[dependencies]` deste crate, e não é
removível: o `tauri_build` monta a ACL varrendo os `tauri-plugin-*` das
dependências **do próprio crate**, então uma permissão de plugin que vem só
pelo `pdv-shared` não existe e o build morre com

```
Permission http:default not found, expected one of core:default, ...
```

Verificado no build do KDS (mesmo padrão). O mesmo vale para os outros
apps da família. `tauri-plugin-log` é a exceção consciente: o shared o
registra e nenhuma permissão `log:*` está no capability.

## Build

```bash
# crate — `tauri build` roda o `beforeBuildCommand` do tauri.conf.json
#    (`cd ../frontend && npm run build:garcon`), então o frontend não precisa
#    ser compilado separado
cargo check          # ou: cargo tauri build
```

O `beforeDevCommand` sobe `npm run dev`, que é o profile `all` (o app
inteiro, com as 4 telas) e não a entry do garçom. O `frontend` não tem um
`dev:garcon` e esta fase não mexe nele. Para desenvolver:

```bash
cd ../frontend && VITE_APP_PROFILE=garcon npm run dev   # terminal 1
cargo tauri dev                                          # terminal 2
```

## Versão

`0.1.0`, **igual** no `Cargo.toml` e no `tauri.conf.json` — o build de entrega
confere os dois e falha se divergirem (divergente, o instalador sai com uma
versão e o `latest.json` outra, e o update "não existe" sem erro nenhum).

Atenção para quem escrever o script de build: a conferência é
`standalone-garcon/Cargo.toml` × `standalone-garcon/tauri.conf.json`. **Não**
compare com `frontend/package.json` — hoje ele está em `1.0.2` e é o
versionamento do bundle web, não dos 4 apps.

## Mobile: o que falta para o build

O `tauri android init` e o `tauri android build` não rodam neste ambiente
(sem Android SDK/NDK). O que falta:

- `gen/android/` (projeto Gradle) — que `tauri android init` gera;
- o `AndroidManifest.xml` e as permissões de sistema;
- o schema de capabilities em mobile (`mobile-schema.json` vs
  `desktop-schema.json` do desktop) — o `$schema` do
  `capabilities/default.json` aponta para `../gen/schemas/desktop-schema.json`,
  que é o schema do desktop. O schema mobile só existe depois do `init`.

O `app.windows` do `tauri.conf.json` tem tamanho de celular (412x892) porque
o `cargo check` do host compila o caminho desktop. No mobile, o Tauri usa a
tela do sistema.

## Pendências conhecidas

- O `Cargo.toml` da raiz precisa listar `standalone-garcon` em `members` (a raiz é
  do orquestrador).
- O `.gitignore` da raiz tem `standalone-*/binaries/`, que esconde o
  `binaries/README.md` deste crate (o `binaries/.gitignore` interno não
  consegue reexcluir o diretório). Ou a regra da raiz vira
  `standalone-*/binaries/*` com exceção, ou a doc do sidecar fica só na raiz
  deste README.
