# 26 — Identidade centralizada: novo login (email/senha), seleção de empresa e sessão por dispositivo

> **Status: PLANO APROVADO — implementação nesta branch (`feat/identidade-login`).**
> Data: 2026-10-18 · Decisor: dono do produto (10 decisões registradas na §2).
> Este workstream (A) roda **antes** do workstream B (multi-tenant RLS); ver §9.
> O plano antigo `multi-tenant-login-correcao.md` (apagado do repo em `308c9977`)
> é contexto histórico: os invariantes de resolução de tenant dele valem, mas a
> recomendação "não migrar para RLS" foi superada pela decisão de schema único.

---

## 1. Objetivo

Trocar o login por seleção de usuário + PIN por **conta global** (email + senha,
com link de recuperação por email e sessão persistente por dispositivo), seguido
de **seleção de empresa** quando o usuário está vinculado a mais de uma loja.

A identidade deixa de ser por-loja: nasce uma **conta global** (quem é você —
tabelas em `public`, fora de qualquer escopo de tenant) separada do **vínculo por
empresa** (a linha em `user`, que continua carregando o papel por loja). Isso é
a camada de identidade centralizada que motivou a decisão pelo RLS.

## 2. Decisões do produto (2026-10-18)

| # | Decisão |
|---|---|
| 1 | O novo login **substitui** o PIN em todos os perfis (inclusive salão/cozinha) |
| 2 | Persistência por **refresh token rotativo por dispositivo** (reuso revoga a família) |
| 3 | Workstream A (login) executa **antes** do B (RLS) |
| 4 | **Gerente convida**: cria usuário com email → sistema gera senha temporária → envia por email → troca obrigatória no primeiro login |
| 5 | Tela antiga de PIN fica como **rota funcional de fallback** (`/login/pin`) com comentário de histórico |
| 6 | Preferência de empresa é **por dispositivo** (localStorage) |
| 7 | OAuth Google/Apple: **somente documentado** (§8), sem código — sem credenciais ainda |
| 8 | Troca de senha temporária é **obrigatória** no primeiro login |
| 9 | Sem SMTP configurado o invite **falha com erro claro** (nunca exibe senha na tela) |
| 10 | JWT de tenant sem "Lembrar de mim" mantém **12h** |

## 3. Modelo de dados

Tabelas **globais** — criadas pelo runner de registry (`migrations/registry/`,
aplicado SOMENTE em `public` com `SET LOCAL search_path = public`; o runner de
tenant nunca as vê, porque `migrations/registry/*.sql` fica fora do alcance do
`migrate.ts`):

- `public.account`: `id` (text PK), `email` (UNIQUE, case-insensitive via
  `lower(email)`), `password_hash` (argon2, **NULL = convite pendente**), `name`,
  `status` (`active`/`suspended`), `must_change_password` (bool), timestamps.
  DORMANT: linha não existe até o primeiro convite/backfill.
- `public.account_identity`: `account_id`, `provider` (`google`/`apple`),
  `provider_sub` — UNIQUE(provider, provider_sub). **Reservado (§8), sem dados.**
- `public.auth_session`: `id`, `account_id`, `refresh_hash` (hash do token),
  `device_id` (opcional), `tenant_slug` (último tenant selecionado), `expires_at`,
  `revoked_at`, `rotated_from` (cadeia de rotação → detecção de reuso).
- `public.password_reset`: `id`, `account_id`, `token_hash`, `expires_at`
  (~30min), `used_at`.

Migração (`migrations/0012_user_account_id.sql`, aplicada **uma vez**, no
schema do app): `ALTER TABLE "user" ADD COLUMN account_id TEXT REFERENCES
public.account(id)` + índice. O `user` continua dono do papel (`role`) e do
estado de login por PIN (fallback).

> **Atualizado (2026-10-21):** a migration rodava "em cada schema de tenant"
> porque o modelo era o schema-por-loja (`docs/15`). No modelo por **linha**
> (`docs/28-multitenant-row-level.md`) as lojas convivem no mesmo schema e a
> `account_id` é uma coluna como outra qualquer — a linha da loja é escolhida
> pelo `tenant_id` + a policy de RLS.

## 4. Contrato de API (CONGELADO — frontend e backend casam exatamente aqui)

Endpoints **novos** (todos sob o escopo de tenant resolvido pelo hook global,
exceto quando indicado):

| Método/rota | Body / Auth | Resposta | Erros |
|---|---|---|---|
| `POST /auth/session` | `{ email, password }` | `{ accountToken, mustChangePassword, companies: [{ slug, name, logoUrl, primaryColor }] }` | 401 `invalid_credentials` (genérico) |
| `POST /auth/password/change` | Bearer **accountToken** + `{ newPassword }` | `{ ok: true }` | 401 |
| `POST /auth/select-tenant` | Bearer **accountToken** + `{ slug }` | `{ token, refreshToken, user: { id, name, role, photoPath } }` | 403 `tenant_not_linked` |
| `POST /auth/refresh` | `{ refreshToken }` | `{ token, refreshToken }` (rotação) | 401 (reuso → revoga família) |
| `POST /auth/logout` | `{ refreshToken }` | `{ ok: true }` | idempotente |
| `POST /auth/password/forgot` | `{ email }` | 202 sempre (sem enumeração) | 503 `email_not_configured` se SMTP ausente (igual p/ todo email — não vaza existência) |
| `POST /auth/password/reset` | `{ token, newPassword }` | `{ ok: true }` | 400 token inválido/expirado/usado |

Endpoints **existentes preservados** (suporte da rota fallback):

- `POST /auth/login` `{userId, pin, deviceId?}` — inalterado (12h, claim `tenant`).
- `GET /auth/users` — inalterado.

Regras do contrato:

- **`accountToken`** = JWT `{ sub: accountId, typ: "account" }`, **10min**, para
  `password/change` e `select-tenant` apenas. O `auth.middleware` atual já o
  rejeita em rota normal sem mudança nenhuma (ele compara `payload.tenant` com o
  escopo; account token não tem `tenant` → `undefined !== slug` → 401).
- **`token`** de tenant = JWT **no formato atual inalterado**
  `{ sub: userId, role, tenant: slug }`, 10min..12h? → **12h** (decisão 10).
- `refreshToken` = valor opaco aleatorio (256 bits); o banco guarda só o hash.
- `companies` = para cada tenant ativo do registry em que o account tem linha em
  `user` (loop `listActiveTenants()` + escopo ALS por tenant lendo `user` e
  `store_settings`); `logoUrl`/`primaryColor`/`name` vêm do `store_settings` da
  respectiva loja.
- Rate limit: `POST /auth/session` usa o mesmo `loginRateLimit` do login PIN;
  forgot usa limite próprio (5/h/IP).
- Email obrigatório na criação de usuário (`POST /users`): cria/relaciona
  `account` (email repetido em outra loja ⇒ **mesma conta**, vínculo novo),
  gera senha temporária, `must_change_password=true`, envia email. **Sem SMTP →
  a criação FALHA com erro claro e nada é gravado** (decisão 9).

## 5. Fluxo

```
/login ─ email+senha ─> POST /auth/session
   │                        │ 401 → erro genérico
   │                        ├ mustChangePassword → troca obrigatória (accountToken)
   │                        └ companies
   │                            ├ 1 empresa → auto select-tenant
   │                            ├ N + pref do dispositivo (localStorage pdv:tenant) ∈ lista → auto
   │                            └ N sem pref → tela de seleção (logo+nome) → grava pref → select-tenant
   └── { token, refreshToken, user } → sessão (localStorage se "lembrar", senão sessionStorage)
```

- **Sem empresa vinculada** → erro na tela: "Nenhuma empresa vinculada a esta
  conta. Contate o gerente."
- **Preferência por dispositivo** (decisão 6): `localStorage["pdv:tenant"]` =
  slug. Nunca é autoridade de segurança — só atalho; o backend revalida o
  vínculo em `select-tenant`.
- Boot da SPA: se houver sessão persistida, decodificar `exp` localmente; com
  < 5min de vida → `POST /auth/refresh` (rotação). Falhou → logout limpo.
  `setUnauthorizedHandler` tenta **um** refresh antes de deslogar.
- Desktop (Tauri): `serverBase` continua sendo a URL do aparelho (um domínio por
  aparelho); o fluxo é o mesmo, a origem `tauri://localhost` não muda.

## 6. Fases de implementação

1. **L1 — Migrations**: `registry/0002_identity.sql` (tabelas globais) +
   `0012_user_account_id.sql` (no schema do app — no modelo por linha as lojas
   convivem nele).
2. **L2 — Backend**: use cases `session`/`select-tenant`/`refresh`/`password`,
   middleware de account token, rotas, invite no `POST /users`, backfill
   (accounts `password_hash NULL` para `user` com email já existente).
3. **L3 — Frontend**: nova `pages/login` (layout de referência), seleção de
   empresa, forgot/reset/change password, rota `/login/pin` com o código antigo
   (comentado como histórico/fallback), `AuthProvider` de dois estágios.
4. **L4 — OAuth**: §8 deste doc, **zero código**.
5. **L5 — Backfill + docs**: `agent-api-index`, `02-frontend-spec`,
   `03-acceptance-criteria`, `agent-frontend-map`, seed dev com emails/senhas.

## 7. Seed e bootstrap

- **Seed dev**: usuários ganham email (`<nome>@pdv.local`) e senha conhecida
  `pdv1234` (`must_change_password=false` em dev); PINs continuam válidos pelo
  fallback. Saída do seed imprime as contas.
- **Seed prod** (`seed:prod`): continua criando o manager com PIN no log (é o
  bootstrap). Se `MANAGER_EMAIL` estiver definido, cria também a conta
  (`MANAGER_PASSWORD` ou senha temporária impressa no log + `must_change=true`).
  Sem SMTP, o fluxo de convite normal falha por decisão 9 — por isso o fallback
  `/login/pin` permanece: é o caminho de primeiro acesso em ambiente sem email.

## 8. OAuth Google/Apple (SOMENTE DOCUMENTAÇÃO — decisão 7)

Quando houver credenciais (app no Google Cloud Console; Apple Developer +
Service ID), o fluxo previsto é:

- `GET /auth/oauth/:provider/start` → gera `state` (guardado em cookie curto,
  SameSite=Lax) e redireciona para o provider com
  `redirect_uri=https://<raiz plataforma>/auth/oauth/callback` — **callback na
  raiz da plataforma, nunca por-tenant** (o redirect de volta ao tenant usa o
  `state`/retorno validado).
- `POST /auth/oauth/:provider/callback { code, state }` → troca code por token,
  lê `sub`/`email`, casa por `account_identity(provider, provider_sub)`; sem
  vínculo e com email confiável casado a um `account` → login direto; caso
  contrário → 401 "conta não vinculada" (sem auto-vinculo silencioso).
- Env vars previstas: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`.
- Desktop: abrir o URL no browser do sistema e voltar via loopback
  (`http://127.0.0.1:<porta>/callback`) — detalhar na implementação real.

## 9. Relação com o workstream B (RLS)

A e B são independentes e A **não** desenha código para B. Pontos de contato já
resolvidos: tabelas de identidade são globais em `public` (futuramente **fora**
das policies); `user.account_id` nasce em A e em B o `user` ganha `tenant_id`;
o claim `{sub, role, tenant}` não muda em nenhum dos dois; `store_settings`
permanece por-loja nos dois modelos.

**O workstream B foi entregue** (2026-10-21, PRs `#216`–`#223`): o modelo —
um schema só, `tenant_id` em toda tabela, RLS como barreira — e as fases
estão em [`28-multitenant-row-level.md`](28-multitenant-row-level.md). A
**identidade do tenant** foi a primeira entrega: `public.tenant` ganhou `id`
(uuid, PK) ao lado do `slug` (rótulo), e o tenant default passou a ser uma
linha do registry com id fixo. Depois vieram o papel restrito do app, a coluna
`tenant_id` com FKs compostas, as policies de RLS, as PKs compostas, o runtime
sem schema, a limpeza dos schemas antigos e o volume de uploads.

Daqui em diante o escopo de tenant (ALS, ports, gateway Go) carrega o **id**, e
o `app.tenant_id` gravado na transação é o uuid — que é o que a policy
compara com a coluna `tenant_id`.

## 10. Verificação

1. Backend: `npm run build` (tsc) e `npm run test` sem falhas.
2. Frontend: `npm run lint`, `npm run build`, `npm run test` sem falhas.
3. Suíte nova (mínimo): sessão com credencial errada/desconhecida → 401
   idêntico; `select-tenant` sem/errado token → 401; empresa sem vínculo → 403;
   rotação de refresh; **reuso de refresh revoga a família**; forgot sem SMTP →
   503; reset expirado/reusado → 400; troca obrigatória bloqueia `select-tenant`
   até concluída; accountToken rejeitado em rota de tenant; convite sem SMTP →
   falha sem gravar.
4. Smoke manual: convidar → email → login → troca de senha → 1 empresa (entra
   direto) / 2 empresas (seletor) → preferência gruda no dispositivo →
   "lembrar" sobrevive ao refresh do browser → logout → fallback `/login/pin`
   operacional.
5. Critérios de aceite correspondentes em `docs/03-acceptance-criteria.md`.

## 11. Riscos aceitos

- `/login/pin` + `GET /auth/users` público continuam existindo (enumeração
  pré-auth) — é o custo do fallback (decisão 5), documentado aqui.
- Cadastro de turno no salão com senha em vez de PIN é mais lento (aceito).
- `password_hash NULL` (convite pendente) não autentica por senha — o caminho é
  o reenvio de convite pelo gerente ou o forgot-password.
