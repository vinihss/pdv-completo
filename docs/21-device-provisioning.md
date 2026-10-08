# 21 — Provisionamento de dispositivo e acesso do usuário

> **Status:** planejamento (sem implementação ainda).
> **Branch:** `feat/provisioning`.
> **Cuidado com homônimos:** "provisionamento" também aparece em `docs/15` §10 e
> `docs/16` §3.7 querendo dizer *provisionar uma loja no registry de tenants*.
> Este doc é sobre **provisionar um aparelho para um usuário** — daqui pra frente
> chamado de **device provisioning** nos nomes de tabela/endpoint.

## 1. Problema

Hoje qualquer pessoa com acesso físico ao tablet/app abre o PDV, escolhe um usuário
na grade e digita o PIN. Não existe noção de "dispositivo confiável":

- O JWT (`{sub, role}`, 12h) é stateless e **não revogável** (`docs/01` §11).
- Não existe tabela de sessão/dispositivo, nem de chave de acesso — greenfield.
- Não existe infra de email no projeto (sem lib, env ou serviço).
- Ao fechar o app, a sessão morre (`sessionStorage`) e o usuário refaz login —
  ok para tablet compartilhado, ruim para o aparelho do garçom.

## 2. Objetivo

1. Cada usuário recebe uma **chave única de provisionamento** (alfanumérica + QR).
2. Na **primeira abertura** do app, o usuário escaneia o QR (ou digita a chave) e o
   aparelho é vinculado a **usuário + tenant**, gravando um registro de dispositivo.
3. Depois de provisionado o app **nunca mais pede a chave** — só o PIN quando for
   aberto, com opional **biometria nativa** no lugar do PIN.
4. O cadastro de usuário ganha uso pleno do **email**: instruções de download +
   chave/QR + PIN, enviados ao criar ou resetar PIN.
5. O gerente **ativa/desativa o acesso** do usuário (e pode revogar aparelhos).

## 3. Decisões (confirmadas)

| # | Decisão | Escolha |
|---|---|---|
| 1 | Envio de email | **SMTP genérico via `nodemailer`** (`SMTP_HOST/PORT/SECURE/USER/PASS`, `MAIL_FROM`). Sem SMTP configurado → envio reportado como `not_configured`, sem quebrar fluxo. |
| 2 | Ciclo de vida da chave | **Multi-uso** até o gerente revogar ou ela expirar. Trocar de celular não exige chave nova. |
| 3 | Plataformas | **QR scan e biometria só nos apps mobile Tauri** (garçom, entregador). Desktop/PWA usam a chave digitada; biometria desktop fica fora. |
| 4 | Credencial persistida | **Device token revogável** emitido no provisionamento, guardado no storage nativo do app (arquivo Rust). PIN/biometria o desbloqueia para obter JWT novo. |

### Fora de escopo (por ora)

- PWA web geral (`appProfile() === "all"`) e app desktop v1 mantêm o fluxo atual
  (grade + PIN, tablet compartilhado — `docs/02` §3). Provisionamento só liga em
  **builds single-app** (`isSingleAppBuild()`).
- Windows Hello / biometria no desktop.
- Attestation de integridade do aparelho (hardening futuro).

## 4. Modelo de dados

Nova migration idempotente **`backend/migrations/0004_device_provisioning.sql`**
(regra vigente: baseline único + incrementais numerados — `AGENTS.md`,
`docs/16` §2). Tabelas de negócio → **dentro do schema de cada tenant**, porque
referenciam `user(id)` do tenant. Hoje (Fase 1) tudo roda em `public`, então o
efeito prático é o mesmo que "tabela global", mas o FK continua válido quando os
schemas divergirem (Fase 2+). Nada disto entra em `migrations/registry/`.

```sql
-- Chave de provisionamento (multi-uso até revoked_at/exp)
CREATE TABLE IF NOT EXISTS public.provisioning_key (
    id              text PRIMARY KEY,
    user_id         text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    code_hash       text NOT NULL,      -- argon2 do código; texto puro nunca persiste
    code_hint       text NOT NULL,      -- sufixo p/ exibir sem expor ("…K7QF")
    created_by      text REFERENCES public."user"(id),
    expires_at      text,               -- null = sem expiração
    revoked_at      text,
    email_sent_at   text,
    created_at      text NOT NULL,
    updated_at      text NOT NULL
);
-- no máximo 1 chave ativa por usuário (índice único parcial)
CREATE UNIQUE INDEX IF NOT EXISTS uq_provisioning_key_active
    ON public.provisioning_key (user_id) WHERE revoked_at IS NULL;

-- Aparelho autenticado
CREATE TABLE IF NOT EXISTS public.user_device (
    id                  text PRIMARY KEY,
    user_id             text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    provisioning_key_id text REFERENCES public.provisioning_key(id),
    label               text,            -- "Galaxy A54", tirado do user-agent/app
    platform            text NOT NULL,   -- android | ios | web | desktop
    app_profile         text NOT NULL,   -- garcon | entregador | pdv | kds
    device_secret_hash  text NOT NULL,   -- argon2 do device token (texto puro só 1x)
    active              boolean NOT NULL DEFAULT true,
    last_seen_at        text,
    revoked_at          text,
    created_at          text NOT NULL,
    updated_at          text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_user_device_user
    ON public.user_device (user_id) WHERE active = true;
```

Espelho Drizzle em `backend/src/infra/db/schema.ts` + tabela nova em
`TRANSIENT_TABLES` (`backend/test/helpers.ts`).

## 5. Fluxo

### 5.1 Geração e envio (gerente)

```
Gerente cria/edita usuário (email preenchido)
  └─ createUser/resetPin  → texto puro do PIN existe SÓ aqui
       └─ (opcão marcada) gera provisioning_key + envia email com PIN + chave + QR

Gerente pode também, a qualquer momento:
  POST /users/:id/provisioning-key   → gira a chave (revoga a anterior)
  POST /users/:id/provisioning-email → reenvia instruções (SEM PIN — não há como
                                        recuperá-lo; para incluir PIN de novo,
                                        use reset-pin com envio de email)
```

- **Código:** 128 bits em base32 legível (`PDV-XXXX-XXXX-XXXX-XXXX`), hasheado com
  argon2. Só o sufixo fica guardado (`code_hint`) para o gerente reconhecer a chave.
- **QR:** payload `PDVPROV1:<código>` — o app já conhece o servidor (apiBase
  embutido/app.json), então o QR carrega só a credencial.
- **Email** (HTML PT-BR): título "Seu app PDV está pronto", instruções de download
  (links dos apps por plataforma), QR em anexo inline (cid) + código em texto para
  digitação, PIN (quando aplicável) e aviso de que a chave só provisiona aparelhos
  daquele usuário.

### 5.2 Primeiro acesso no app

```
App single-app abre (BootGate) → sem credencial de dispositivo?
  └─ ProvisionScreen
       ├─ [mobile] Escanear QR  → tauri-plugin-barcode-scanner
       └─ Digitar código        → sempre disponível
            └─ POST /public/provisioning/exchange  {code, platform, appProfile, deviceLabel}
                 ├─ rate limit (5/min/IP) + argon2 verify
                 ├─ INSERT user_device (device token = 32 bytes, devolvido 1x)
                 ├─ logAction "device_provisioned"  (mesma transação)
                 └─ enqueueEvent → room "alerts:manager"  (gerente vê o aparelho novo)
            └─ app grava {deviceId, deviceToken, user} no storage nativo
                 └─ tela de PIN com o usuário VÍNCULADO já pré-selecionado
```

### 5.3 Aberturas seguintes (nunca mais o QR)

```
App abre → tem credencial salva?
  ├─ Usuário tem biometria habilitada → prompt nativo
  │    └─ ok  → POST /auth/device/refresh {deviceId, deviceToken} → JWT (token rotaciona)
  │    └─ falha → cai para o keypad PIN
  └─ keypad PIN → POST /auth/login {userId, pin, deviceId}
       └─ backend valida: user ativo + device conhecido/ativo
```

- O JWT continua curto (12h) e morre no `sessionStorage` — fechar o app pede
  PIN/biometria de novo, como pedido. **A sessão persistente é o device token,
  não o JWT.**
- "Trocar usuário" num app provisionado **não existe**: o aparelho pertence a um
  usuário. Troca de usuário = gerente revoga/reprovisiona o aparelho.

### 5.4 Ativar/desativar acesso (gerente)

| Ação | Efeito |
|---|---|
| `PATCH /users/:id {active:false}` | Login já nega (`login.usecase`). **Novo:** revoga todos os `user_device` do usuário na mesma transação + `logAction` → sessões abertas perdem o refresh. |
| `DELETE /devices/:id` (ou PATCH) | Revoga só aquele aparelho (perde refresh na hora). |
| Reativar usuário | Device não volta sozinho — exige novo provisionamento (ou desativar a revogação em cascata, decisão na implementação; default = não voltar). |

**Lacuna fechada:** com JWT de 12h sem revogação, "desativar" não matava sessão
aberta. O `auth.middleware` passa a verificar `user.active` (query indexada com
cache de ~30s) — corte efetivo em segundos para REST e WebSocket.

## 6. API (delta)

Todos os novos endpoints seguem o padrão: zod na fronteira, `requireRole("manager")`
nas rotas de gerente, `AppError` do catálogo, audit na mesma transação.

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/users/:id/provisioning-key` | manager | Gira a chave (revoga a anterior). Retorna `{code, qrPayload, expiresAt}` **1x**. |
| POST | `/users/:id/provisioning-email` | manager | (Re)envia email de instruções; `{includePin?:boolean}` só funciona logo após create/reset-pin. |
| GET | `/users/:id/devices` | manager | Lista aparelhos (label, plataforma, last_seen, ativo). |
| DELETE | `/devices/:deviceId` | manager | Revoga aparelho. |
| POST | `/public/provisioning/exchange` | público + rate limit | Troca código por credencial de dispositivo. Retorna `{deviceId, deviceToken, user}`. |
| POST | `/auth/device/refresh` | público + rate limit | `{deviceId, deviceToken}` → JWT novo + deviceToken rotacionado. Exige device e user ativos. |
| POST | `/auth/login` | (existente) | Ganha campo opcional `deviceId` → valida vínculo ativo. Sem `deviceId`, comportamento atual preservado (PWA/tablet). |

Sem `withIdempotency` novo: nenhum endpoint criador de recurso não idempotente
(girar chave é naturalmente idempotente-serializável; exchange gera registro novo
por design). `correlationId` segue opcional no corpo.

## 7. Email — infra nova

- Deps novas: `nodemailer` (transport) + `qrcode` (gera o PNG do QR anexado).
- `backend/src/infra/mail/mailer.ts`: transport SMTP lazy a partir do env;
  seam `setMailerForTests`; sem `SMTP_HOST` → `{sent:false, reason:"not_configured"}`
  (dev/local não quebra).
- `backend/src/infra/mail/provisioning-email.ts`: template HTML PT-BR + QR cid.
- Env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM` — em `backend/.env.example` e no compose do `deploy/`.
- Envio **pós-commit** (depois do COMMIT da escrita de domínio); falha não desfaz
  a geração da chave e é reportada ao gerente (`sent:false` + motivo) e auditada.
- ⚠️ Risco aceito e documentado: o PIN trafega em email. Mitigação operacional:
  instrução no email de trocar o PIN no primeiro acesso (backlog, não bloqueia).

## 8. Frontend (bundle web)

| Parte | Onde |
|---|---|
| Tela de primeiro acesso (escanear/digitar) | `frontend/src/app/boot/` — alongside `SetupForm.jsx`/`BootGate.jsx`; gate: `isSingleAppBuild() && !deviceCredential`. |
| Chamadas de API | entity nova `frontend/src/entities/provisioning/api/` + barrel `index.js` (endpoints públicos em `api/public.js`, regra do `features/README.md`). |
| Ação/UI do fluxo | `frontend/src/features/provisioning/` (`api/ model/ ui/ index.js`). |
| Login com usuário pré-selecionado | `frontend/src/pages/login/LoginPage.jsx` — novo estado da máquina `select | pin | provisioned` (em `provisioned` a grade não aparece). |
| Persistência da credencial | Tauri: arquivo próprio no dir de config (comandos novos `device_config`/`save_device_config` em `standalone-shared`, **sem mexer no contrato do `app.json`** — `docs/15` §7). Web/single: `localStorage["pdv:device"]`. |
| Desbloqueio por biometria | `AuthProvider.jsx`: se credencial + biometria ligada → prompt nativo no boot → `device/refresh` → sessão; fallback = keypad. |
| Gestão no painel do gerente | `UsersTab.jsx` / `UserModal.jsx`: (a) checkbox "Enviar email de provisionamento" em criar/resetar PIN; (b) botão "Reenviar instruções" + modal com QR (lib `qrcode` já existe no frontend) e código; (c) seção "Aparelhos" com revogar; (d) toggle ativar/desativar já existe → ganha aviso "revoga os aparelhos". |

## 9. Apps Tauri (Rust)

- Plugins novos (**dep direta em cada `Cargo.toml`**, para o ACL achar a permissão —
  regra da casa): `tauri-plugin-barcode-scanner` e `tauri-plugin-biometric`
  (mobile-only; verificar compatibilidade com Tauri 2.12 na implementação).
- Registro em `standalone-shared/src/plugins.rs` (gate mobile, como os demais);
  capabilities em `standalone-*/capabilities/default.json`; `CAMERA` no
- Para efeitos deste doc, **apenas o app `standalone-pdv` é relevante para o
  provisioning** — os apps RN (Garçom/Entregador) não usam esses manifests e moram
  no repo `pdv-mobile-apps`.
- Scan de QR só onde há câmera — desktop segue com código digitado.

## 10. Realtime e audit

- Rooms (já assinadas pelo gerente): eventos `device_provisioned`,
  `device_revoked`, `user_access_changed` em `alerts:manager`
  (critério 6 do `AGENTS.md` — evento tem que chegar em room assinado).
- Ações de audit (na mesma `db.transaction`): `provisioning_key_generated`,
  `provisioning_email_sent`, `device_provisioned`, `device_revoked`,
  `user_access_toggled`.
- `last_seen_at` atualizado no `device/refresh` (sem audit — seria ruído).

## 11. Segurança

- Código com 128 bits de entropia + argon2 → brute force inviável; ainda assim
  rate limit dedicado (5/min/IP) no `/public/provisioning/exchange` e no
  `/auth/device/refresh` (`loginRateLimit` já cobre o login).
- Device token: 32 bytes base64url, hash argon2 no banco, **rotação a cada refresh**.
- Texto puro de código/PIN/device token só na resposta do momento da geração.
- Verificação de `user.active` no `authMiddleware` (cache ~30s) para revogação de
  sessões abertas.
- Biometria é porta local (UX): o segredo desbloqueado é o device token. Se o
  aparelho for comprometido, a proteção real é a revogação pelo gerente. Hardening
  futuro: guardar o token cifrado em keystore nativo.
- JWT segue sem tenant claim (Fase 1 — `docs/15` §4.5); nada muda aqui.

## 12. Critérios de aceite (entram como §19 em `docs/03-acceptance-criteria.md`)

1. **Dado** usuário com email e chave gerada, **quando** o app single-app abre sem
   credencial, **então** oferece escanear QR ou digitar código (não mostra a grade).
2. **Dado** código válido, **quando** `exchange` roda, **então** cria `user_device`
   vinculado a usuário+chave e o app cai direto no PIN do usuário pré-selecionado.
3. **Dado** aparelho provisionado, **quando** o app fecha e reabre, **então** pede
   PIN (ou biometria, se habilitada) e **nunca** a chave de novo.
4. **Dado** dispositivo com biometria habilitada, **quando** a biometria valida,
   **então** o app obtém JWT via `device/refresh` sem digitar PIN.
5. **Dado** usuário desativado pelo gerente, **quando** ele tenta login ou refresh,
   **então** é negado — e sessões JWT abertas são derrubadas em ≤ ~30s.
6. **Dado** aparelho revogado, **quando** o app tenta refresh, **então** perde
   acesso e volta para a tela de provisionamento.
7. **Dado** SMTP configurado, **quando** gerente cria usuário com email (opção
   marcada), **então** o email sai com download + QR/chave + PIN; sem SMTP, o
   gerente vê "não configurado" e nada quebra.
8. **Dado** chave revogada/girada, **quando** um aparelho usa a chave antiga,
   **então** o `exchange` recusa.

## 13. Sequência de entrega (PRs curtos, trunk-based)

| PR | Escopo | Validação |
|---|---|---|
| 0 | Este doc + critérios em `docs/03` §19 + índice (`AGENTS.md`/`agent-api-index`) | revisão |
| 1 | Migration `0004` + Drizzle + usecases/rotas (key, exchange, devices, refresh, login+deviceId, cascata de revogação) + audit/outbox + `TRANSIENT_TABLES` + suíte `backend/test/provisioning.test.ts` | `npm run build` + `npm run test` |
| 2 | Infra de email (`mailer`, template, envs, compose) + gatilhos em create/reset-pin + "reenviar" | build + testes (mailer com seam de teste) |
| 3 | Frontend: entity, ProvisionScreen/BootGate, LoginPage pré-selecionado, UsersTab/UserModal (QR, aparelhos, toggle) | `lint` + `build` + `test` |
| 4 | Tauri: plugins scanner/biometric, capabilities, manifest, comandos `device_*`, unlock por biometria | `cargo check`/build do garçom + smoke no APK |
| 5 | Smoke E2E por perfil + atualização de `agent-frontend.md`/`agent-backend.md` | checklist do `AGENTS.md` |

## 14. Pendências / decisões em aberto

- Reenvio de email **com** PIN exige reset de PIN (não dá para recuperar o PIN
  hasheado) — UX disso na implementação.
- Ao reativar usuário, aparelhos revogados voltam ou não? Default: não.
- Download do app: quais links entram no email (Play Store, APK, TestFlight)?
- Web/PWA single-app (instalado no tablet do garçom) entra depois — hoje é
  desktop-gate no `BootGate`; estender a gate é mudança pequena.
- Keystore nativo para cifrar o device token (hardening).
