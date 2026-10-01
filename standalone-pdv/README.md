# PDV Caixa — app nativo da frente de caixa

Crate Tauri do app **Frente de Caixa** (`com.pdvapp.caixa`) da família
standalone. É o app do balcão: gaveta, fechamento de conta, clientes e
**impressão térmica** — e é o único dos 4 que imprime, o que é o motivo de
`src/printing/` existir aqui.

> **Não confundir com o app em produção.** `frontend/src-tauri`
> (`com.pdvapp.desktop`, productName "PDV", v1.0.11) continua no repo, em
> produção, em transição. Os dois apps coexistem na mesma loja durante a
> troca. Por isso tudo que identifica este app é distinto: `productName`
> "PDV Caixa", `identifier` `com.pdvapp.caixa` e um endpoint de update só
> dele.

## Com o que este app se divide

| Onde | O quê |
|---|---|
| `standalone-shared` (crate `pdv_shared`) | o `app.json` por instalação (`AppConfig`), os 3 commands de config e o registro comum de plugins (`builder`). Também o **esquema** de impressoras (`Transport`, `PrinterProfile`, `PrintersConfig`), importado e não reimplementado. |
| este crate | ciclo de vida, `tauri.conf.json`, capabilities, e `printing/` — render ESC/POS, spooler do Windows, status do aparelho, transporte TCP. |

Duas decisões que moram no shared e que valem saber:

- **A config fica fora do diretório de instalação** (`%APPDATA%\PDV\app.json`,
  com `%ProgramData%` como padrão de máquina). O auto-update substitui os
  arquivos do diretório de instalação a cada versão, então config dentro dele
  seria sobrescrita e a loja perderia a URL do backend e as impressoras.
- **O HTTP vai pelo Rust** (`tauri-plugin-http`), nunca por `fetch` no webview:
  o app roda na origem `tauri.localhost` e o backend libera CORS só para o
  domínio configurado, então o `fetch` seria bloqueado pelo navegador do app.

## ACL: os 3 plugins são dependência direta, mesmo sem registro aqui

Quem registra os plugins é `pdv_shared::builder`. Ainda assim
`tauri-plugin-http`, `-process` e `-updater` estão em `[dependencies]` deste
crate, e não são-removíveis: o `tauri_build` monta a ACL varrendo os
`tauri-plugin-*` das dependências **do próprio crate**, então uma permissão de
plugin que vem só pelo `pdv-shared` não existe e o build morre com

```
Permission http:default not found, expected one of core:default, ...
```

Verificado nesta rodada (build de teste do crate, `capabilities/default.json`
igual ao do app v1). O mesmo vale para os outros 3 apps da família.
`tauri-plugin-log` é a exceção consciente: o shared o registra e nenhuma
permissão `log:*` está no capability.

## Build

```bash
# O sidecar do daemon de impressão SAIU do build: o printer foi reestruturado
# e `printer/scripts/build-sidecar.sh` não existe mais. O `externalBin` foi
# removido do tauri.conf.json, então não há passo de Go/sidecar.

# crate — `tauri build` roda o `beforeBuildCommand` do tauri.conf.json
#    (`cd ../frontend && npm run build:pdv`), então o frontend não precisa ser
#    compilado separado
cargo check          # ou: cargo tauri build
cargo test           # inclui o golden ESC/POS contra o renderizador Go
```

O `beforeDevCommand` está **de propósito ausente**: o `frontend` não tem script
`dev:pdv` (só `build:pdv`), e subir o dev server sem profile serviria o app
`all` dentro da janela do caixa — pior do que não subir. Para desenvolver:

```bash
cd ../frontend && VITE_APP_PROFILE=pdv npm run dev   # terminal 1
cargo tauri dev                                      # terminal 2
```

## Versão

`0.1.0`, **herdada do workspace**: o `Cargo.toml` deste crate tem
`version.workspace = true` e o `tauri.conf.json` **não declara** `version` (o
Tauri lê do `Cargo.toml` do crate). Bump em família inteira:
`./bump-version.sh <x.y.z>` na raiz — que atualiza o `Cargo.toml` da raiz e o
`frontend/package.json`.

## Update

Endpoint próprio:
`https://app.umamisushiarte.com.br/updates/caixa/desktop/{{target}}/{{arch}}/{{current_version}}`.
O `pubkey` é a mesma do app antigo (é a chave da família), mas o **caminho do
manifesto é por app**: com o endpoint do app antigo, o caixa e o app em
produção publicariam no mesmo `latest.json` e um consumiria o update do outro.
Acompanhamento dessa rota no Caddy é do orquestrador.

## Instalador e serviço

`installer-hooks.nsh` instala o daemon de impressão como serviço
(`PDVPrinterDaemon`) durante o POSTINSTALL, e o desinstalador para e apaga.
O corpo é idêntico ao do app antigo — não havia path hardcoded. O que muda são
comentários e as mensagens de log. Sobre a transição: os dois apps usam o
**mesmo** nome de serviço, de propósito (uma máquina, uma impressora, um
daemon, e é o nome que o runbook de `printer/` documenta). O gancho é
apaga-e-recria, então o instalador mais recente é quem o serviço aponta; com o
mesmo binário, nada muda em campo. Detalhes no próprio `.nsh`.

## Pendências conhecidas

- O `externalBin` do daemon de impressão está **removido** (printer
  reestruturado, `build-sidecar.sh` não existe mais): o instalador não
  embute o daemon e o `installer-hooks.nsh` pula o registro do serviço com
  aviso — e antes disso ele para/apaga o serviço existente. Retomar junto
  com o novo printer.
- O `Cargo.toml` da raiz precisa listar `standalone-pdv` em `members` (a raiz é
  do orquestrador).
- A rota `/updates/caixa/*` ainda não existe no Caddy.
- O `.gitignore` da raiz tem `standalone-*/binaries/`, que esconde o
  `binaries/README.md` deste crate (o `binaries/.gitignore` interno não
  consegue reexcluir o diretório). Ou a regra da raiz vira
  `standalone-*/binaries/*` com exceção, ou a doc do sidecar fica só na raiz
  deste README.
