# 23 — Reavaliação da estratégia multi-tenant (schema por loja vs. schema único + tenant_id)

> **Status: DECISÃO PENDENTE — nada neste documento foi implementado.**
> Reabertura deliberada, pelo dono do produto, da decisão registrada em
> [`15-multi-tenant-schema.md`](15-multi-tenant-schema.md). Motivo declarado (2026-10-09):
> *"como eu não tenho clientes reais rodando ainda, não seria prudente repensar o modelo
> multi-tenant? usar somente 1 schema com tenant_id?"* — vinculado à intenção de adotar
> OAuth 2.0/OIDC (identidade central) e à possibilidade de abandonar o SaaS no futuro.
>
> **Data:** 2026-10-09 · **Autor:** coordenação do repositório (com base em leitura de código)
> **Decisor:** dono do produto. **Encerra quando:** o dono escolher uma opção das §5–7.

---

## 1. Contexto, em uma frase

O sistema hoje isola lojas por **schema PostgreSQL** (`tenant_<slug>`), com pool dedicado por
schema cujo `search_path` é fixado no startup packet; a pergunta em aberto é se isso continua,
se volta a ser **uma base compartilhada com `tenant_id` + RLS**, ou se vira híbrido.

## 2. Histórico que precisa estar na mesa (três iterações)

| Iteração | Estado | Desfecho |
|---|---|---|
| **Row-level (`store_id` em ~22 tabelas)** | Existiu, removido em `7c259cd` (PR #54) + `0012_remove_multi_tenant.sql` | **Vazou dado real entre lojas** (relatado no plano antigo: usuário de uma loja lia produtos, comandas, clientes, caixa e entregas da Loja Padrão — o filtro era opcional) |
| **Schema-por-tenant (`tenant_<slug>`)** | **Vigente e implementado** (registry, ALS, pool por schema, JWT com claim `tenant`, provisionamento `npm run db:provision`, suíte `tenant-routing.test.ts`) | Decisão registrada em `docs/15` (2026-10-04/05), que **rejeitou** shared schema + RLS (ver §3) |
| **Reavaliação (este doc)** | Em discussão | Dono reabriu a decisão antes de qualquer cliente real operar |

> ⚠️ **Discrepância a verificar antes de decidir:** `docs/15` (2026-10-05) registra
> *"o primeiro cliente real (`umamisushiarte.com.br`) é um domínio próprio"*, com `custom_domain`
> no registry. O dono afirma (2026-10-09) que não há clientes reais rodando. As duas afirmações
> não coexistem; o custo da migração muda conforme a resposta. Confirmar qual é a verdade antes
> de usar "sem clientes" como premissa do "custo ~zero de migração de dados".

## 3. A objeção anterior a shared schema + RLS (e o que mudou)

A decisão de 2026-10-04 rejeitou RLS por motivos documentados (docs/15 §2) e **medidos**:

1. **O app conecta como superuser** — medido em produção (2026-10-04): `pg_roles` devolve
   `pdv | t | t` (`rolsuper` = true). **Superuser sempre burla row security**, mesmo com
   `FORCE ROW LEVEL SECURITY`. Ou seja: *na configuração atual*, adotar RLS seria fachada —
   e o projeto já pagou caro por fachada de isolamento.
2. **O vazamento histórico do modelo row-level** — o filtro por loja era convenção, não barreira.
3. Rollback de loja = restore de schema; eliminação LGPD = `DROP SCHEMA … CASCADE`; un tenant
   quebrado não derruba os outros.

**O que mudou desde então — nada no código, tudo no contexto:**

- **Sem clientes reais** (a confirmar, §2) → a migração de dados deixa de ser o custo dominante;
  o custo vira reescrita da camada de acesso + testes.
- A reabertura está **acoplada ao plano OAuth 2.0/OIDC**: Authorization Server e identidade
  centralizada ficam trivailmente simples num schema único, e desconfortáveis com identidade
  espalhada por N schemas.
- A possibilidade de **sair do SaaS** favorece modelo onde "uma loja = uma linha" em vez de
  provisionamento de schema.

**O que NÃO mudou (e não vai mudar por decreto):**

- **RLS só é real com role dedicada.** Enquanto o app conectar como superuser, qualquer policy
  é decoração. Adotar shared schema implica: criar role `NOBYPASSRLS` não-superusuária, migrar
  privilégios de todas as tabelas/sequências/funções, `FORCE ROW LEVEL SECURITY` + policy em cada
  tabela de negócio, e o `SET LOCAL app.tenant_id` por transação. É trabalho de camada de acesso,
  não um `ALTER`.
- **A cultura "lembre-se de filtrar por loja" já falhou uma vez neste projeto** (iteração 1).
  A mitigação não é confiar em disciplina: é RLS fail-closed + teste de regressão cross-tenant
  obrigatório no CI. O `tenant-routing.test.ts` atual vira esse teste.

## 4. A decisão a tomar

> **Onde a segregação física entre lojas mora: schema PostgreSQL (hoje) ou coluna `tenant_id`
> com RLS (proposta)?** Escopo da decisão: dados de negócio (orders, comandas, users,
> estoque, caixa…). Fora de escopo: `public.tenant` (registry) continua em `public` em qualquer
> opção; resolução `host → tenant`, custom domains e TLS on-demand (Caddy) continuam igual.

## 5. Opção A — Manter schema-por-tenant (status quo)

**Favorável:**
- Barreira estrutural: o pool **só fala com um schema**; vazamento entre lojas é impossível por
  construção (salvo o buraco real do gateway Go, §8.2).
- Rollback/LGPD por loja são atômicos no catálogo (`DROP SCHEMA … CASCADE`).
- Decisão já tomada em docs/15; zero rework da camada de acesso.

**Contra (medido/código):**
- **Teto operacional:** `tenant-db.ts` — pool por tenant (`max: 4`) com LRU de **16 pools
  (`TENANT_POOL_MAX_TOTAL`)**. Com 20+ lojas ativas, o LRU vive derrubando/recriando pools;
  com Postgres default (100 conexões), o teto conceitual fica perto de 20–30 lojas.
- **45 pontos de escopo obrigatório** (`enterTenantScope`/`ensureTenantScope`/`runInTenantScope`
  em todo handler, workers, outbox, maintenance) — cada feature nova precisa lembrar do escopo;
  já há workaround manual no login (`resolveTenant` se ALS vazio).
- Migrations aplicam em N schemas (com registry de tenant) e provisionamento de loja nova é
  multi-etapa (`db:provision` + bootstrap) — complexidade operacional que cresce com o número
  de lojas.
- Relatórios consolidados do dono e reconciliações (Pagar.me, iFood) exigem UNION entre schemas
  ou ETL.
- Workers (Pagarme/iFood/outbox) iteram tenants (`runInTenantScope`) — fan-out fixo.
- `docs/15` admite o teto de conexões como custo aceito (§2), não eliminado.

## 6. Opção B — Schema único + `tenant_id` + RLS

**Desenho (o que a implementação exigiria):**
1. `tenant_id text NOT NULL REFERENCES public.tenant(slug)` em toda tabela de negócio, como
   **primeira coluna de índices e constraints unique** (ex.: `uq_user_email (tenant_id, email)`).
2. Role própria do app: superuser sai de cena; role `NOBYPASSRLS`; grants migrados.
3. `FORCE ROW LEVEL SECURITY` + policy `USING (tenant_id = current_setting('app.tenant_id', true)::text)`.
4. Cada transação faz `SET LOCAL app.tenant_id = …` com o tenant **resolvido e autenticado**
   (host/JWT), nunca de input do cliente. O ALS existente continua sendo o transporte desse valor.
5. `store_settings` singleton → uma linha por tenant.
6. Migrations voltam a ser single-schema (baseline único, sem runner por schema).

**Favorável:**
- **Um pool, um limite de conexões**; escala com pgbouncer (modo transação) sem reescrever código.
- Onboarding de loja = `INSERT` em `public.tenant` + seed de settings; provisionamento
  (`provision-tenant.ts`, `db:provision`) some como etapa de infra.
- Relatórios/consolidação nativos (`WHERE tenant_id` / `GROUP BY`).
- **Sinergia direta com OIDC**: identidade (`user`) vira tabela com `tenant_id` na mesma base —
  o Authorization Server enxerga um diretório único; a "decisão de onde a identidade mora" da
  thread de auth deixa de existir.
- **Standalone futuro trivial**: uma loja = uma linha; mesmo binário, mesmo runbook.
- **RLS fail-closed**: query esquecida sem `WHERE tenant_id` retorna vazio; o teste de regressão
  prova isso no CI.

**Contra:**
- **É a maior reescrita de infra do projeto até hoje** (camada de acesso, migrations, testes,
  workers, provisionamento) — mesmo com custo de dados ~zero.
- **Exige a role dedicada** (§3) — operação em produção: revogar superuser do app é uma mudança
  que pode quebrar DDL/migrations que hoje rodam como superuser.
- Ruído de vizinho: query pesada de uma loja afeta todas (mitigável: timeouts, índices com
  `tenant_id` à frente, particionamento por `tenant_id` quando `orders` crescer).
- A disciplina histórica ("filtro opcional") volta a existir como superfície — mitigada por RLS,
  mas a confiança tem que ser construída de novo.
- Backup/restore "por loja" deixa de ser físico e vira lógico (dumps filtrados).

## 7. Opção C — Híbrido: shared por default, schema como tier (não recomendado agora)

Rodar shared + RLS como padrão, e oferecer schema dedicado como opção "isolamento premium" para
lojas que exigirem. **Custo: duas camadas de acesso convivendo** (ordens rodeiam diferentes
storage), testes em matriz dupla, provisionamento duplicado. Só faz sentido depois que a Opção B
estiver estável e houver demanda de mercado comprovada — hoje é o pior dos dois mundos.

## 8. Riscos transversais (valem EM QUALQUER opção)

1. **RLS inerte hoje** (superuser) — se decidir por B, a troca de role é pré-requisito, não
   etapa final.
2. **Gateway Go ignora a claim `tenant` no WebSocket** (verificado 2026-10-09:
   `ws-gateway/internal/auth/auth.go` não valida cross-tenant). É um buraco real na promessa de
   isolamento da Opção A **e** uma brecha que a Opção B precisa fechar da mesma forma.
3. **Documentação em conflito:** `docs/15` (e `docs/17`, runbook de migrations por tenant)
   descrevem a arquitetura vigente. Se a decisão for B, esses docs precisam ser atualizados **na
   mesma mudança** — deixar convivendo viola a regra de conflito do AGENTS.md.
4. **Baseline de migrations:** o filename de migration é identidade persistida em `_migrations`
   (`backend/migrations/README.md`). Com clientes reais, resetar baseline exige runbook
   (docs/17); sem clientes, é editar `0001_init.sql` direto + re-seed.

## 9. Estimativa de esforço (ordens de grandeza, sujeitas a refinamento)

| Opção | Esforço | Observação |
|---|---|---|
| A (manter) | ~0 | + correções de hardening: gateway Go, auditoria, lockout |
| B (shared + RLS) | semanas (2–4 dev) | Reescrita da camada de acesso + tests + role migration; sem migração de dados |
| C (híbrido) | A + B + integração dupla | Não recomendado nesta fase |

## 10. Ponto de não-retorno

Não existe não-retorno técnico absoluto, mas o custo relativo cresce **linearmente com o código
construído sobre o modelo atual e com clientes operando**. A janela de custo mínimo é: antes do
primeiro cliente real e antes do plano OIDC travar contratos de token/identidade (identidade
central depende desta decisão).

## 11. Decisões a tomar (pelo dono)

1. **Opção A, B ou C?** (recomendação deste documento: B —* se* a premissa "sem clientes reais"
   se confirmar; senão, A com hardening)
2. Confirmar a discrepância do §2: existe cliente real ou não?
3. Sendo B: trocar a role do app para `NOBYPASSRLS` é aceitável operacionalmente?
4. **Sequência**: a Fase 0 de auth (matar `/auth/users` público, PIN mínimo 6, lockout Redis,
   auditoria de login) é agnóstica de schema e pode começar já — autorizado?

## 12. Referências

- `docs/15-multi-tenant-schema.md` — decisão vigente + §2 (objeção a RLS) + §3 (arquitetura)
- `docs/17-runbook-unificacao-migrations.md` — runbook de migrations por tenant
- `backend/src/infra/db/tenant-db.ts` — pool por schema + LRU (teto medido)
- `backend/src/infra/db/tenant-context.ts` — ALS de escopo (45 pontos de uso)
- `backend/src/infra/db/provision-tenant.ts`, `backend/src/http/routes/provisioning.routes.ts`
- `backend/test/tenant-routing.test.ts` — suíte de isolamento vigente
- `ws-gateway/internal/auth/auth.go` — gateway Go: validação de JWT sem claim `tenant`
- Thread de auth: decisão OAuth 2.0/OIDC (doc futuro, pendente desta decisão)