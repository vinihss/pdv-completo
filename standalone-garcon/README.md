# PDV Garçom — app mobile da família standalone

Crate Tauri do app **Garçom** (`com.pdvapp.garcon`) para lançamento de pedidos
direto na mesa. Família: `standalone-pdv` (Caixa), `standalone-kds` (Cozinha),
`standalone-garcon` (Garçom), `standalone-entregador` (Entregador).

## Decisões-chave

| Item | Valor | Explicação |
|---|---|---|
| `productName` | `PDV Garçom` | Distinto do app v1 (`frontend/src-tauri`) que continua em produção. |
| `identifier` | `com.pdvapp.garcon` | Único por app, permite coexistir na mesma máquina/loja. |
| `frontendDist` | `../frontend/dist/garcon` | Bundle do profile `garcon` (já existe em `frontend/dist/garcon/index.html`). |
| `version` | `0.1.0` | Igual em `tauri.conf.json` e `Cargo.toml`. |
| `updater` | **false** | Distribuição por loja/APK, não por `latest.json`. Não há bloco `plugins.updater`. |
| `process` | **false** | Plugin não existe em mobile; sem updater não há quem chame `app.restart()`. |
| **Impressão** | **não** | Sem `externalBin`, `installer-hooks.nsh`, módulos de impressão. |
| **Plugins** | via `pdv_shared::Plugins` | `Plugins { updater: false, process: false, log: false }.apply(...)` — **explicitamente**, não via `pdv_shared::builder()` (que liga tudo). |

## O que vem do shared

- `pdv-shared` (`pdv_shared`): `AppConfig`/commands (`app_config`, `save_app_config`, `reset_app_config`) e registro de plugins.
- `tauri-plugin-http` é **dependência direta** (ACL): necessário para `http:default` constar nas permissions descobertas pelo `tauri_build`. O registro continua por `Plugins::apply`.

## Comandos

```bash
# Verificar
cargo fmt --check 2>/dev/null || rustfmt --edition 2021 --config tab_spaces=2,max_width=100 src/lib.rs src/main.rs build.rs
cargo check
```

> **Nota workspace:** Este crate **ainda não** está em `[workspace.members]` do `/Cargo.toml`. O erro `current package believes it's in a workspace when it's not` ao rodar `cargo check` dentro do crate é **esperado** nesta fase (conforme instruções). Não edite `/Cargo.toml` nem tente corrigir com `exclude`.

## Pendências para build mobile (Android/iOS)

**Não é possível rodar `tauri android init/build` neste ambiente** (sem Android SDK/NDK). O que falta:

1. **Projeto Android/Gradle** (`gen/android/`) — gerado por `tauri android init`.
2. **AndroidManifest.xml** e permissões de sistema — gerados/ajustados pelo `init`.
3. **Schemas de capabilities mobile** — hoje o `$schema` em `capabilities/default.json` aponta para `../gen/schemas/desktop-schema.json` (existe em build desktop). Com `tauri android init` surgem `gen/schemas/mobile-schema.json` (ou schemas específicos por target) e o schema mobile passa a ser o correto.
4. **Validação de ACL mobile** — o Tauri 2 usa schemas distintos para desktop/mobile; o apontamento atual é **esperado até o `init` rodar** (não inventar).

**Observações:**
- `app.windows[0]` tem tamanho celular coerente (412×892). No mobile o Tauri usa a tela do sistema — este entry existe porque o host compila o caminho desktop.
- O `invoke_handler` registra **apenas** os 3 commands do shared (sem commands próprios de domínio).
- Seguindo o padrão dos apps irmãos: comentários explicam o *porquê*, não o óbvio.
