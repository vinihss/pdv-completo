# 11 — App desktop, instalador e daemon de impressão

Como o PDV vira um programa Windows que a loja instala sozinho, com a
impressora térmica já funcionando e sem ninguém precisar compilar nada no
computador do caixa.

Este documento cobre: o que é um instalador e por que ele precisa de um
"instalador de verdade" (e não um ZIP), como o app se configura sozinho em
cada loja, como o daemon de impressão entra junto, e o que ainda não está
pronto.

> **STATUS (set/2026) — app v1 em modo de manutenção, desacoplado do frontend.**
> Este é o doc do app v1 (`com.pdvapp.desktop`), que continua no repo e em
> produção. O que mudou em relação ao texto abaixo é o **arranjo do repo**, não
> o app:
>
> - `frontend/` é só a aplicação web (e o bundle que os apps standalone servem);
>   o app desktop v1 vive em `frontend/src-tauri/` como **diretório desacoplado**.
> - **Build manual**: `bash frontend/src-tauri/build-app.sh` (funciona de
>   qualquer diretório — o script resolve os caminhos pela própria localização).
>   Os scripts `desktop:*` saíram do `frontend/package.json`.
> - **CLI do Tauri na raiz do repo**: `node_modules/.bin/tauri`
>   (`@tauri-apps/cli` no `package.json` da raiz); nada disso se instala mais em
>   `frontend/node_modules`. Para o v1, rode a CLI com cwd = `frontend/`.
> - **A versão do v1 vem do `frontend/src-tauri/Cargo.toml`** (+ conferida contra
>   `frontend/package.json` pelo `build-app.sh`): o `tauri.conf.json` do v1 não
>   declara mais `version`. Onde o texto abaixo cita "version no
>   `tauri.conf.json`", leia o `Cargo.toml` do crate.
> - **O `build-desktop.yml` deixou de buildar o v1**: hoje ele é o caminho
>   canônico dos instaladores da família `standalone-*` (matriz `pdv`/`kds`).
>   Parágrafos que descrevem "o CI gerando o instalador do v1" são de antes
>   dessa separação — o v1 agora é só este script manual.
> - **Sidecar**: `printer/scripts/build-sidecar.sh` não existe mais e o
>   `externalBin` saiu do `tauri.conf.json` do v1 (ver
>   `docs/agent-frontend.md` §Sidecar). §4/§5 descrevem o instalador com o
>   daemon embutido — que é o que volta quando o novo printer for embutido de
>   novo; o `installer-hooks.nsh` continua no lugar, esperando o binário.
>
> Caminhos como `src-tauri/...`, `entities/...`, `src/lib.rs` usados neste doc
> são relativos a `frontend/` e `frontend/src/`.

## Decisões que sustentam o resto

| Decisão | Motivo |
|---|---|
| Tauri (e não Electron) | Instalador de ~5 MB contra ~150 MB, e o WebView2 já vem no Windows 10/11. |
| Instalador único, config por loja | O mesmo `.exe` vai para todas as lojas; o que muda (API, IP da impressora) fica em arquivo, não no executável. |
| Tauri updater (não Inno Setup) | O instalador precisa **se reinstalar sozinho** no update. Inno não faz isso. |
| Falha de update não bloqueia | Loja sem internet precisa abrir o PDV. Update é tentei-de-novo, não bloqueio. |
| Daemon como serviço do Windows | A cozinha imprime mesmo com o app fechado. |
| Daemon copiado para a pasta do app | Um `.exe` em uso não pode ser sobrescrito; se o serviço apontasse direto para o sidecar, o update do app falharia. |

## 1. O instalador

O instalador é um `.exe` único (NSIS, gerado pelo Tauri) que faz três coisas:

1. instala o app em `C:\Program Files\PDV`;
2. instala o **daemon de impressão** como serviço do Windows;
3. cria a pasta de dados em `%ProgramData%\PDV` (config do app e do daemon).

Uma loja recebe o mesmo arquivo que outra. Não existe "instalador da loja A" e
"instalador da loja B" — o que muda é a configuração, escrita no primeiro uso
(ou deixada no arquivo, se o técnico preferir adiantar — ver §2).

### Instalação por máquina, não por usuário

`installMode: perMachine` significa que o app fica em `Program Files` e vale
para todos os usuários do Windows. Isso é deliberado: o caixa e o gerente
usam o mesmo computador, e um app por usuário quebraria o serviço de impressão
(o serviço do Windows é do sistema, não do usuário logado).

O instalador pede elevação de administrador. Sem ele não é possível registrar
serviço.

### WebView2 offline

O app roda dentro do WebView2. Em máquinas sem internet, o instalador traz o
WebView2 junto (`webviewInstallMode: offlineInstaller`) em vez de tentar
baixar. Só é um custo de download na primeira instalação.

## 2. Configuração por loja

O app guarda onde está o sistema e o daemon. São dois arquivos, com ordem de
leitura definida:

```text
%APPDATA%\PDV\app.json           configuração do usuário (tem prioridade)
%ProgramData%\PDV\app.json       padrão da máquina, opcional
```

O primeiro boot cria o de `%APPDATA%`. O de `%ProgramData%` é para o técnico
deixar pronto (o instalador cria a pasta, mas não o arquivo — ver §9.3).

Conteúdo:

```json
{
  "mode": "local",
  "apiBase": "http://127.0.0.1:3000",
  "daemonUrl": "http://127.0.0.1:8080"
}
```

| Campo | O que é |
|---|---|
| `mode` | `local` (sistema nesta máquina) ou `cloud` (servidor remoto). |
| `apiBase` | Endereço do backend do PDV. |
| `daemonUrl` | Endereço do daemon de impressão local. |

`mode` não é decoração: é o que decide a **ordem do boot** e o texto de erro
na tela de bloqueio (ver §3).

O usuário logado no Windows não é o mesmo que usa o PDV. Por isso o
`%APPDATA%` acima é o do usuário que abriu o app — a configuração "da loja" é
a de máquina (`%ProgramData%`), e o `%APPDATA%` só serve para um técnico
ajustar algo sem mexer no padrão.

### Onde se mexe

- **Pelo app, no perfil gerente**: Configurações → Aplicativo. Tem o botão de
  restaurar o padrão.
- **No primeiro uso**, se não houver config: o app abre a tela de configuração
  em vez de tentar abrir e falhar.
- **No arquivo**, para o técnico: `%ProgramData%\PDV\app.json`.

O endereço da impressora **não** está aqui. Ele fica no config do daemon
(`%ProgramData%\PDV Printer\config.json`) — são coisas diferentes: o app
precisa saber onde o daemon está, e o daemon precisa saber onde a bobina
está.

## 3. O boot

Antes de abrir o app, ele obrigatoriamente:

1. verifica se há atualização;
2. instala se houver;
3. confere se o sistema responde;
4. só então abre.

A ordem **muda conforme o `mode`**, porque o problema mais comum é diferente
em cada caso:

| `mode` | Ordem | Se a API não responder |
|---|---|---|
| `cloud` | health check → update → app | "Sem conexão com o sistema" (tem internet, é rede/servidor) |
| `local` | update → health check → app | "O sistema local não está rodando" (sem internet é normal aqui) |

O plano local faz o update primeiro de propósito: numa loja sem internet o
update gasta o timeout (3 s) e o app abre normalmente. O plano nuvem faz o
health check primeiro, porque o manifesto de update mora no mesmo servidor —
dá para avisar "sem internet" já no primeiro segundo, sem esperar timeout.

### Regras que não mudam

- **Falha de update não bloqueia.** Sem internet, ou com servidor de update fora
  do ar, o app abre na versão que está no disco. O update é tentei-de-novo.
- **API fora do ar bloqueia.** Não dá para operar o PDV sem backend, então a
  tela é de erro com "Tentar de novo" — não é um modal que se dispensa.
- **No web (PWA), nada disso acontece.** O `BootGate` só existe no desktop.
- O update instala e o app reabre sozinho.

## 4. O daemon de impressão

O daemon (Go, `printer/daemon/`) vai embutido no instalador como **sidecar** e
é registrado como serviço do Windows.

### O que o instalador faz com ele

```text
1. para o serviço (o .exe em uso não pode ser sobrescrito)
2. copia o sidecar para C:\Program Files\PDV\printer\
3. registra o serviço PDVPrinterDaemon (início automático, reinício em falha)
4. inicia
```

Tudo isso acontece **também a cada atualização do app**, porque o updater
reexecuta o instalador. É o que mantém o daemon na mesma versão do app sem
passo manual.

### O que o instalador não apaga

```text
%ProgramData%\PDV Printer\config.json    IP e template das impressoras
%ProgramData%\PDV Printer\data\          fila de impressão
```

Desinstalar o app **não** desliga a impressora de uma loja que continua usando
o sistema. Só o binário sai.

### Onde o daemon procura o config

```text
1. --config <caminho>
2. %PDV_PRINTER_CONFIG%
3. %ProgramData%\PDV Printer\config.json
4. ./config.json
```

O passo 3 é o padrão no Windows, e é por isso que o `binPath` do serviço não
leva argumento nenhum: o caminho é padrão e não precisa ser escapado no `sc.exe`.

Se o arquivo não existir, o daemon cria um padrão e continua funcionando com
ele em memória. As impressoras nascem **sem endereço** — o `/health` responde
`ready: false`, que é o estado honesto de uma instalação nova (e diferente de
"no ar", que é `status: ok`).

### Templates

Os três layouts (cozinha, motoboy, fiscal) são **embutidos no binário**. Um
template em `%ProgramData%\PDV Printer\templates\` sobrescreve o embutido de
mesmo id, então layout de cliente continua possível sem recompilar.

Detalhe completo do daemon em `printer/README.md`.

## 5. Estado atual

| Parte | Situação |
|---|---|
| Config local/cloud por loja | pronto |
| Boot com health check e tela de erro | pronto |
| Sequence de update no boot | pronto e **ativo** (§6) |
| Daemon como sidecar + serviço | pronto (validado em Linux, falta Windows) |
| Update automático (baixa e instala) | pronto no código, **falta provar no Windows** (§8) |
| Chave Ed25519 + assinatura do artefato | pronto (`TAURI_SIGNING_PRIVATE_KEY` no secret) |
| Publicação do manifesto (CI + Caddy) | pronto no código, só roda na primeira tag |
| Instalador em produção | falta a primeira tag `v*.*.*` |
| Assinatura Authenticode (SmartScreen) | **não implementado** — §7 |

A lista do que falta de verdade, com evidência de cada item, está em **§9**.

O que está pronto foi testado por suíte automatizada (`frontend` com vitest,
`printer/daemon` com `go test`) e o caminho de assinatura foi validado gerando
artefato assinado num build local. O que depende de Windows — o instalador
NSIS, o serviço, a troca de arquivos no update — ainda não foi rodado numa
máquina real e não deve ser considerado validado até que alguém abra o `.exe`
num Windows 10/11 limpo.

## 6. Update automático (ligado)

O caminho completo, do boot até o servidor:

```
boot (BootGate)
  └─ runBootSequence → checkForUpdate()        [entities/updater/api/updater.js]
       └─ plugin-updater (Rust)  GET /updates/desktop/windows-x86_64/x86_64/<versão-atual>
            └─ Caddy: rewrite → /updates/latest.json
       └─ valida a assinatura Ed25519 do manifesto (pubkey no tauri.conf.json)
  └─ installUpdate() → baixa o .exe.zip, confere a assinatura, roda o instalador
  └─ relaunch()
```

Peças, e onde cada uma mora:

| Peça | Onde |
|---|---|
| `tauri-plugin-updater` (Rust) | `src-tauri/Cargo.toml` + `.plugin()` em `src/lib.rs` |
| Permissão `updater:default` | `src-tauri/capabilities/default.json` |
| Chave pública + endpoint | `src-tauri/tauri.conf.json` → `plugins.updater` |
| Assinatura do artefato | `bundle.createUpdaterArtifacts: true` |
| Versão amarrada à assinatura | `plugins.updater.requireSignedVersion: true` |
| Instalação sem travar o app | `plugins.updater.windows.installMode: passive` |
| Lógica de falha não bloqueia | `entities/updater/api/updater.js` + `bootSequence.js` |
| Endpoint e artefatos | `deploy/Caddyfile` → `/updates/desktop/*/*/*` e `/updates/files/*` |
| Build + assinatura + publicação | `.github/workflows/build-desktop.yml` (por tag via `deploy-on-tag.yml`, ou por `workflow_dispatch`) |
| Chave privada + senha | secrets `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

Quatro decisões que valem explicadas:

- **A URL é dinâmica mas o arquivo é um só.** O plugin pede
  `/updates/desktop/{{target}}/{{arch}}/{{current_version}}`; o Caddy faz
  `rewrite` e devolve sempre o mesmo `latest.json`. Assim um app na 0.2.0
  enxerga o manifesto da 0.3.0 sem o servidor precisar saber quantas versões
  antigas ainda existem em campo.
- **O `.exe` viaja dentro de um `.zip`.** É o que o plugin baixa (`url` no
  manifesto) e o que ele valida (`signature`). O `.exe` sozinho fica
  publicado do lado para download manual, e o `.sig` para auditoria.
- **`requireSignedVersion: true` amarra a versão à assinatura.** O manifesto é
  baixado por TLS, mas não é assinado; sem essa flag, quem conseguisse servir
  uma resposta adulterada poderia apontar uma `version` inflada para a `url` +
  `signature` de uma versão antiga e forçar um *downgrade* para um artefato
  genuíno. Com a flag, o `version` vem do trusted comment da assinatura. O
  `tauri build` grava a versão sozinho; o custo é que releases assinados
  antes dessa versão do CLI deixam de ser aceitos (não há nenhum publicado
  ainda).
- **A tag tem que bater com a versão publicada** (era o `current_version`
  conferido contra o `tauri.conf.json` no CI).
  Sem isso, uma tag `v0.3.0` com `version: 0.2.0` no conf publicaria um
  manifesto que nenhum app reconhece — e o update pareceria simplesmente não
  existir, sem erro em lugar nenhum. *(Desde o desacoplamento: o conf do v1 não
  declara mais `version` — ela vem do `frontend/src-tauri/Cargo.toml` —, o CI
  passou a buildar a família `standalone-*` e a conferência tag×versão do v1 é
  manual, no `build-app.sh`; ver nota de status no topo.)*

### 6.1 Publicar uma versão

```bash
# 1. version em frontend/src-tauri/Cargo.toml e frontend/package.json
#    tem que ser a mesma da tag (o tauri.conf.json do v1 não declara
#    `version` mais; o build-app.sh falha se os dois divergirem).
git tag v0.3.0 && git push --tags
```

O job `build-desktop` roda em `windows-latest`: compila o instalador NSIS
assinado, monta o `latest.json`, publica por SSH em `deploy/updates/` no
servidor e anexa o instalador na release do GitHub. O job `deploy` só roda
depois dele (`needs:`), então o manifesto nunca chega antes do backend no ar.
**Hoje esse job cobre a família `standalone-*`; o instalador do v1 sai do
`frontend/src-tauri/build-app.sh`** (ver nota de status no topo).

### 6.1.1 Gerar o instalador sem tag (só o instalador)

O job acima não tem steps próprios: ele chama
**`.github/workflows/build-desktop.yml`**, que é a definição única do
instalador (hoje, o da família `standalone-*` — o do v1 é o `build-app.sh`;
ver nota de status no topo). Esse workflow também aceita `workflow_dispatch`,
então dá para produzir o instalador a qualquer momento pela aba **Actions** →
**Instalador Windows (Tauri)** → **Run workflow**:

| Input | Efeito |
|---|---|
| `publicar_no_servidor` (padrão marcado) | assina, cria/atualiza a release e publica `latest.json` + `.exe` em `deploy/updates/` — é o que o app instalado consulta |
| `publicar_no_servidor` desmarcado | gera e anexa na release, **sem** servir o manifesto: o app instalado não encontra essa versão (serve para checar o build do runner sem mexer no ar) |
| `nota` (opcional) | texto do update mostrado no app |

Três coisas que valem saber antes de usar essa porta:

- **A release é nomeada pela versão publicada** do commit escolhido (o conf
  não declara mais `version` — ela vem do `Cargo.toml` do crate construído),
  não pela branch. O run avisa quando a ref não é tag.
- **A release aponta para o commit que assinou o artefato** (`--target
  ${{ github.sha }}`): sem isso ela nasceria no topo da branch padrão, com o
  mesmo nome de versão mas outro código.
- **Repetir a mesma versão sobrescreve o `latest.json` servido.** O run
  manual é exatamente para isso — republicar é a intenção —, mas isso
  significa que um dispare acidental entrega uma versão que você não testou
  no Windows.

O `.github/workflows/desktop-windows.yml` é legado: gera `.msi`/`.exe` em
release rascunho, sem assinatura e sem publicar o manifesto. Não é o
caminho de publicação — ele está marcado no próprio arquivo.

O serviço de impressão continua no caminho: o `installer-hooks.nsh` roda a
cada instalação, e o update é uma instalação.

### 6.2 A chave de assinatura

A chave Ed25519 é o que impede qualquer terceiro de assinar um update falso.
A **pública** está no `tauri.conf.json` (pode ir no repositório); a
**privada** e a **senha** vivem só nos secrets:

| Onde | O quê |
|---|---|
| `tauri.conf.json` → `plugins.updater.pubkey` | pública (base64 do arquivo `.pub`) |
| secret `TAURI_SIGNING_PRIVATE_KEY` | privada (conteúdo do arquivo `.key`) |
| secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | senha da chave |

A senha não é opcional: sem ela no ambiente, o CLI tenta perguntar por
prompt e o build falha em runner sem terminal. Cópia de segurança da chave e
da senha fora do repositório — quem perde não assina versão nenhuma e o app
fica preso na versão em disco. Trocar a chave exige gerar o par novo,
atualizar o `pubkey` no conf e republicar o manifesto; nada disso acontece por
conta própria.

## 7. O que falta: assinatura Authenticode

O instalador sem assinatura Authenticode mostra "App desconhecido" ao abrir
(SmartScreen). Isso é separado do update: o artefato já é assinado em
Ed25519 e o app aceita instalar; o que falta é o selo do Windows.

Ordem sugerida: certificado Authenticode (autoridade ou auto-assinado) →
segredo no repositório → flag de assinatura no CI. O certificado autoritativo
é custo real; auto-assinado resolve o aviso, mas o cliente ainda precisa
confirmar a assinatura uma vez.

## 8. Como testar de verdade

O que já dá para testar em Linux/macOS:

```bash
cd frontend
npx vitest run src/app/boot src/shared/lib    # boot e config
cd ../printer/daemon && go test ./...         # daemon
```

O build do v1 é manual e sai de qualquer diretório (o script se localiza pelo
próprio caminho em `frontend/src-tauri/`):

```bash
# build local (instalador do sistema atual; sem sidecar — printer reestruturado)
bash frontend/src-tauri/build-app.sh

# caminho de assinatura de ponta a ponta (gera artefato + .sig)
TAURI_SIGNING_PRIVATE_KEY="$(cat /caminho/seguro/pdv-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat /caminho/seguro/senha)" \
  bash frontend/src-tauri/build-app.sh --release --bundles deb
```

O instalador de Windows (NSIS) só sai no Windows; no Linux/macOS use
`--bundles deb`/`appimage` para validar o caminho. É o que o
`build-desktop` faz no `windows-latest`, com `--bundles nsis`.

### 8.1 O AppImage não empacota no Arch

No Arch o `tauri build` morre em `failed to run linuxdeploy`. Não é bug do
projeto: o `linuxdeploy` embute um `strip` de binutils antigo, que não
reconhece a seção `.relr.dyn` das libs do sistema (o Arch usa binutils
novo). O `.deb` sai normal na mesma máquina — só o AppImage é afetado.

Quando for o caso:

```bash
bash frontend/src-tauri/build-app.sh --bundles deb        # .deb nativo, funciona no Arch
bash frontend/src-tauri/build-app.sh --appimage-docker    # AppImage num debian:bookworm-slim
```

A segunda forma empacota num container (imagem `frontend/docker/Dockerfile.desktop`,
cacheada; a primeira vez baixa as deps). Sai o mesmo AppImage que o CI gera,
só que com glibc 2.36 em vez das libs da máquina.

### 8.2 Build local sem chave de assinatura

O empacotador do Tauri 2 assina o artefato de update **sempre** que
`plugins.updater.pubkey` está no `tauri.conf.json`, e não existe flag de
config que desligue isso (`-c` com `pubkey: ""` continua pedindo chave;
`updater: null` morre antes com "failed to get updater configuration").
Sem `TAURI_SIGNING_PRIVATE_KEY`, o build local terminava com erro **depois**
de gerar o instalador.

Por isso o `frontend/src-tauri/build-app.sh` sem `--release` gera uma chave
descartável em `frontend/src-tauri/.local-signing.key` (ignorada pelo git) e
avisa: um
instalador assinado com ela **não** é aceito pelo updater de um app real,
porque a pubkey do conf é outra. Serve para o script sair com status 0 e
para o `.sig` existir, o que é o que o CI valida. Entrega é sempre com a
chave de verdade, via `--release`.

O que **exige** um Windows limpo:

1. rodar o instalador gerado;
2. confirmar o serviço `PDVPrinterDaemon` no `services.msc`;
3. imprimir um cupom de teste com a MP-4200;
4. publicar um update falso e ver o app atualizar sozinho;
5. desinstalar e conferir que o config do daemon sobreviveu.

Sem o passo 4 e o 5 no Windows, a parte mais arriscada (o update trocando o
executável de um serviço em execução) continua sem prova.

## 9. Pendências reais

O que está escrito aqui como "pronto" foi testado ou inspecionado;
o que está nesta lista **não foi provado**. Nada aqui é chute: cada item tem
um sintoma que dá para reproduzir ou um arquivo que não existe.

### 9.1 Bloqueia a primeira versão

| # | Pendência | Evidência / onde | Como resolver |
|---|---|---|---|
| 1 | **Guardar a chave e a senha fora do repo.** Hoje estão em `/tmp/opencode/pdv-updater.key` e `.password`, que é temporário. | Sem a privada, nenhuma versão é assinável; sem a senha, o CLI cai num prompt e o build falha. | Copiar os dois arquivos para local durável (gerenciador de senhas + backup offline). Depois, considerar revogar: trocar a chave é gerar par novo, atualizar `plugins.updater.pubkey` e republicar o manifesto. |
| 2 | **Os secrets de servidor foram cadastrados (29/09); falta só o do host key.** `gh secret list` mostra `HOSTINGER_HOST`, `HOSTINGER_PORT`, `HOSTINGER_USER`, `HOSTINGER_SSH_KEY`, `HOSTINGER_APP_PATH`, `UPDATE_BASE_URL` e os dois `TAURI_SIGNING_*`. Não há `HOSTINGER_SSH_FINGERPRINT`, então a verificação de host key está desligada nas quatro actions (`fingerprint` sem secret é no-op). O `HOSTINGER_KNOWN_HOSTS` existe mas é inerte. | `deploy/README.md` §Secrets | Cadastrar `HOSTINGER_SSH_FINGERPRINT` com o `SHA256:` da linha `ecdsa-sha2-nistp256` de `ssh-keyscan -p 22 HOST \| ssh-keygen -lf -` (a do ed25519 dá mismatch — é a última preferência do cliente). Opcional: remover `HOSTINGER_KNOWN_HOSTS`, que não verifica nada. |
| 3 | **A primeira tag ainda nao existe.** `frontend/src-tauri/Cargo.toml` e `frontend/package.json` estao em `1.0.2` (iguais entre si, que e o que o `build-app.sh` exige). | O build do v1 falha se o Cargo.toml e o package.json divergirem — de proposito (a conferencia tag x conf no CI nao cobre mais o v1, ver nota de status). | `git tag v1.0.2 && git push origin v1.0.2`, ou gerar so o instalador com `bash frontend/src-tauri/build-app.sh`. |
| 4 | **Rodar a primeira tag de verdade.** O caminho do manifesto foi provado com Caddy local e diretório falso, nunca contra o VPS. | `deploy/Caddyfile` + volume `./updates` | Apos a primeira publicacao: `curl https://app.umamisushiarte.com.br/updates/desktop/windows/x86_64/0.0.0` tem que devolver o `latest.json` (a versao do URL e ignorada pelo `rewrite` — 0.0.0 so para nao nascer de um app real). |

Detalhe do item 4 que só aparece em produção: `deploy/updates/` fica **untracked**
dentro do clone no servidor. O `git checkout -f` do deploy preserva, mas um
`git clean -fdx` manual apagaria o manifesto e o endpoint passaria a devolver
404 — sintoma idêntico a "update não existe".

### 9.2 Bloqueia a validação

| # | Pendência | Por que continua aberta |
|---|---|---|
| 5 | **`installer-hooks.nsh` nunca foi compilado.** | Não há Windows nem `makensis` neste ambiente; o hook é a parte que mexe no serviço do Windows, e um erro de sintaxe NSIS só aparece na primeira build real. |
| 6 | **Update de verdade no Windows** (passos 4 e 5 do §8). | Sem Windows: o `.exe` que troca o executável de um serviço em execução nunca rodou. |
| 7 | **`installUpdate` → `relaunch` nunca exercitados.** | No Windows o instalador fecha o processo em andamento, então o `relaunch()` pode não completar e o splash oferece o botão — caminho previsto, nunca executado. |
| 8 | **Impressão com o serviço rodando.** | O daemon foi testado por `go test` e pelo `deb`, mas a impressão real (MP-4200) só na loja. |

### 9.3 Decisões em aberto

| # | Pendência | Detalhe |
|---|---|---|
| 9 | **O instalador não escreve `%ProgramData%\PDV\app.json`.** | Hoje quem grava é o app, no primeiro boot. O texto do §1/§2 e do `src/lib.rs` foi corrigido para não prometer o que não acontece, mas a decisão continua: ou o NSIS passa a gravar esse padrão (útil quando o técnico configura a loja antes de o primeiro usuário logar), ou fica só com o `SetupForm`. |
| 10 | **Assinatura Authenticode** (§7). | O update já é assinado em Ed25519; o selo do Windows (SmartScreen) segue ausente, por escolha. |
| 11 | **Segunda plataforma.** | O `latest.json` só tem a chave `windows-x86_64`. Se sair Linux/macOS, o manifesto precisa de outra chave e o CI de outra matriz — hoje `build-desktop` é Windows-only. |
| 12 | **Divergência de versão JS×Rust do Tauri.** | Já aconteceu uma vez (`@tauri-apps/api` 2.12 vs crate 2.11) e o `cargo check` passava enganando. O gatilho é mexer em `@tauri-apps/*`. |
