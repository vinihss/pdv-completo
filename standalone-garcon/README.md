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

## Android: como gerar o APK

O projeto Gradle (`gen/android/`) é **versionado** — é ele que carrega o
`AndroidManifest.xml`, a liberação de cleartext, o signing do release, a versão
lida do `Cargo.toml` e a correção do BuildTask (os quatro itens em "Correções
sobre o template"). **Não rode `tauri android init` por cima sem olhar o
diff**: o init regenera os arquivos e some com as quatro mudanças. O init só é
necessário num clone que ainda não tenha `gen/android/`.

### Requisitos

| O quê | O que foi usado |
|---|---|
| JDK | **17** (`JAVA_HOME=/usr/lib/jvm/java-17-openjdk`) |
| Android SDK | `platforms;android-36`, `build-tools;36.0.0`, `platform-tools` (compileSdk 36, o que o template gera) |
| NDK | r30 (`30.0.16248370`) — o init já detecta o do sistema |
| Rust | `rustup target add aarch64-linux-android` |
| Node | `npm ci` na **raiz** do repo (CLI) e em `frontend/` (bundle) |
| Gradle | wrapper `8.14.3`, baixado no primeiro build |

Dois detalhes de ambiente que quebram o build se faltarem:

- **JDK 17, e não o JBR do Android Studio.** O `tauri android init` detecta o
  JBR do Android Studio (25 nesta máquina); o Gradle 8.14.3 não sobe nele.
- **`ANDROID_HOME` num SDK gravável.** O SDK do sistema (`/opt/android-sdk`)
  é root-owned; o `sdk.properties`/`local.properties` é gitignored, então quem
  builda aponta `ANDROID_HOME` para um SDK próprio. Se o SDK não tiver
  `platforms;android-36`, o Gradle tenta baixar sozinho e morre em licença.

### Build

```bash
cd standalone-garcon
export ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME=/opt/android-sdk/ndk/30.0.16248370
export ANDROID_NDK_ROOT=/opt/android-ndk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
export TAURI_FRONTEND_PATH="$PWD/../frontend"   # sem isto o beforeBuildCommand
                                                # roda no cwd errado (ver build-standalone.sh)
node ../node_modules/@tauri-apps/cli/tauri.js android build --apk -t aarch64 --ci
```

- `-t aarch64` = só arm64-v8a, o que praticamente todo celular atual usa. Os
  outros ABIs (`armv7`, `i686`, `x86_64`) saem trocando o `-t`; `--split-per-abi`
  gera um APK por ABI em vez de um unificado.
- `--ci` só evita prompt; não muda o resultado.
- Rode **de dentro do crate**: da raiz a CLI acha o `tauri.conf.json` errado
  (o app v1, em `frontend/src-tauri`, está mais perto).

O artefato sai assinado em
`standalone-garcon/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
(~20 MB). O nome leva `universal` porque é o nome do *flavor* que o `rust`
plugin cria — as ABIs dentro dele são as que o `-t` escolheu (neste build, só
`lib/arm64-v8a/`, conferido com `unzip -l`). O Tauri **não** copia o APK para
`target/release/bundle/apk/`, como faz no desktop.

O `app.windows` do `tauri.conf.json` continua com tamanho de celular
(412x892) porque o `cargo check` do host compila o caminho desktop; no
Android o Tauri usa a tela do sistema e a janela do conf é ignorada.

### Assinatura do release (obrigatória para instalar)

O template do Tauri não declara `signingConfigs`, então sem chave o
`assembleRelease` sai como `app-universal-release-unsigned.apk` — que o Android
recusa. O `app/build.gradle.kts` lê **`gen/android/app/keystore.properties`**
(junto dele, como o `tauri.properties` do template; os dois caminhos são
gitignored):

```properties
storeFile=../pdv-garcon.keystore   # relativo a app/ → gen/android/
storePassword=...
keyAlias=pdv-garcon
keyPassword=...
```

Gerar uma chave local:

```bash
cd gen/android
keytool -genkeypair -keystore pdv-garcon.keystore -alias pdv-garcon \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <senha> -keypass <senha> -dname "CN=PDV Garcon, O=PDV, C=BR"
# e escrever app/keystore.properties com a mesma senha
```

Sem `keystore.properties` o build ainda sai (só sem assinar) — serve para
conferir bundle. **Antes de publicar de verdade, troque pelo keystore da loja**:
depois de publicado o app não pode mudar de chave.

### As 4 correções sobre o template

1. **Cleartext no release.** O template só liga `usesCleartextTraffic` no
   debug. No release ele ficaria `false`, e a partir do targetSdk 28 o
   Android bloqueia socket em claro para **qualquer** biblioteca — inclusive o
   `tauri-plugin-http` (reqwest) por onde o app fala com a API. Como o plano
   LOCAL do produto é `http://<ip-da-lan>:3000`, o bloqueio derrubaria a
   conexão com time out mudo. O app agora libera cleartext nos dois build
   types, igual ao desktop. Se um dia o produto abandonar o plano local em
   HTTP, é aqui que se volta.
2. **Signing do release** — ver "Assinatura do release", acima.
3. **`BuildTask.kt`.** O template invoca `node tauri android
   android-studio-script`, o que só resolve se existir um pacote npm chamado
   literalmente `tauri`. Este repo instala `@tauri-apps/cli`, e o comando morre
   com `Cannot find module 'tauri'` lá dentro do Gradle — depois de tudo o
   resto já ter compilado. O BuildTask agora aponta o
   `node_modules/@tauri-apps/cli/tauri.js` da raiz e falha com mensagem
   orientando a rodar `npm ci`.
4. **Versão.** O template lê `tauri.properties` para `versionName`/`versionCode`
   e **nada escreve esse arquivo** — o default é `1.0`/`1`, e o primeiro build
   saiu com esses valores, divergentes dos `0.1.0` do `Cargo.toml`. O
   `build.gradle.kts` agora lê `[workspace.package].version` da raiz (o que o
   `./bump-version.sh` altera) e deriva o `versionCode` como
   `major*1_000_000 + minor*1_000 + patch`, crescente a cada release.

### Ainda não provado

- **Instalação em aparelho**: o APK deste build não foi instalado/rodado num
  celular (o smoke por perfil de `docs/03-acceptance-criteria.md` continua
  pendente para mobile).
- **iOS**: `tauri ios init` não foi feito; só Android.
- **CI**: não existe workflow de Android — o `build-desktop.yml` é Windows e
  os `standalone-*` ficam fora de propósito.
- **Play Store**: sem `aab`, sem keystore da loja e sem checagem de
  `versionCode` entre publicações.

## Pendências conhecidas

- Nenhuma conhecida. (O item antigo — "o `Cargo.toml` da raiz precisa listar
  `standalone-garcon` em `members`" — já foi resolvido: o crate está em
  `members`.)
