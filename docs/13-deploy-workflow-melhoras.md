# 13 — Melhorias do workflow de deploy

> Análise técnica e plano incremental para evoluir o deploy blue/green atual
> (`deploy/switch.sh`), mantendo compatibilidade com o que já funciona e
> reduzindo risco em produção.

**Status:** proposta (nada implementado)
**Escopo:** `deploy/`, `.github/workflows/`, healthcheck do backend

---

## 1. Filosofia e princípios

O deploy atual (blue/green + `switch.sh` + healthcheck como portão) está bem
estruturado. As melhorias proposta visam fortalecer previsibilidade,
reprodutibilidade e segurança, sem quebrar o funcionamento existente.

| Princípio | Justificativa | Aplicação |
|---|---|---|
| **Build once, deploy many** | Elimina drift entre ambientes: staging e produção passam a rodar exatamente o mesmo artefato. | Buildar a imagem uma única vez (por commit/tag), publicá-la no GHCR e promover a **mesma digest** entre ambientes. |
| **Healthcheck como gate determinístico** | Hoje o switch já aborta se o verde estiver doente. Isso está correto. | Separar `readiness` (pronto para tráfego) de `liveness` (app vivo), com timeout explícito para boot + migrations. |
| **Fail-safe por padrão** | Evita re-tentativa de requisição não-idempotente (Caddy sem `lb_retries`) — decisão acertada. | Manter essa regra. Priorizar **rollback automático** em falhas técnicas óbvias. |
| **Tudo auditável** | Essencial para pós-mortem e troubleshooting. | Registrar `commit`, `image@digest`, `tag`, autor, ambiente, duração, resultado do switch, probe de downtime e se houve rollback. |
| **Evolução incremental** | Reduz risco: cada fase é validada em staging antes de tocar em produção. | Seguir o plano P0 → P1 → P2 → P3 (seção 12). |

---

## 2. Branching, releases e triggers

| Sugestão | Estado atual | Proposta | Ganho |
|---|---|---|---|
| **Versionamento SemVer** | Tags manuais (`v1.0.14`, `v1.4.0`, `v1.4.1`). | Automatizar com [release-please](https://github.com/googleapis/release-please) ou [changesets](https://github.com/changesets/changesets) sobre Conventional Commits. | Gera `CHANGELOG.md`, cria tag + GitHub Release, elimina erro humano. |
| **Deploy por tag** | `deploy-on-tag.yml` chama `build-desktop.yml` (única definição — correto). | Disparar deploy de backend/frontend por `push: tags: ['v*']` **ou** `workflow_dispatch` com `environment`, `ref` e `image_ref`. | Deploy reprodutível: sempre se sabe exatamente qual artefato foi publicado. |
| **Staging → produção com promoção** | Deploy único por tag. | Criar dois **GitHub Environments** (`staging` e `production`). Staging: automático em `v*.*.*-rc*`. Produção: **aprovação manual obrigatória**, consumindo a **mesma imagem** validada no staging. | Reduz risco drasticamente; valida smoke antes de promover. |

> **Recomendação:** não automatizar produção no push direto de tag ainda.
> Começar com `workflow_dispatch` + Environment Protection Rules.

---

## 3. Build, imagens e artefatos

Hoje o `switch.sh` faz build local (`--no-build` já existe). Isso dificulta a
promoção entre ambientes e não escala para múltiplos hosts.

| Melhoria | Sugestão | Detalhes |
|---|---|---|
| **Registry de imagens** | [GHCR](https://docs.github.com/pt/packages/working-with-a-github-packages-registry) (`ghcr.io/<org>/<repo>-api`). | Imagens imutáveis, auditáveis, fáceis de promover e rollback por digest. |
| **Tags múltiplas** | `:vX.Y.Z`, `:vX.Y`, `:sha-<short>`, `:latest` (só staging). | Permite fixar por versão exata ou digest. **Nunca** `:latest` em produção. |
| **Build once** | `build-and-push.yml` (tag `v*`): build + push → exporta `image_digest` e `image_ref` como outputs. | O deploy consome **exatamente** a imagem validada (`@sha256...`). |
| **Buildx + cache** | `docker/setup-buildx-action` + `cache-from/to: gha`. | Reduz tempo de build significativamente. |
| **Multi-arch (futuro)** | `platforms: linux/amd64,linux/arm64`. | Útil em migração de hosts (ARM). Pode ficar para P3. |
| **SBOM + provenance** | `provenance: true`, `sbom: true` no `build-push-action`. | Melhora supply-chain security a custo baixo. |

**Pinning:** no deploy, referenciar `ghcr.io/vinihss/pdv-completo-api@sha256:...`.
O `switch.sh` deve aceitar `IMAGE_REF` (tag **ou** digest) para manter
retrocompatibilidade.

---

## 4. Healthcheck: readiness vs liveness

O `/health` atual funciona bem como **liveness**. Falta um **readiness** estrito
para servir de gate do blue/green.

| Endpoint | Uso | Critério de "pronto" |
|---|---|---|
| **`GET /healthz`** (liveness) | Healthcheck interno (Docker/K8s). | App inicializado, HTTP 200, resposta leve e rápida. Evita restart desnecessário em pico. |
| **`GET /readyz`** (readiness) | **Gate do blue/green** (o que o `switch.sh` espera). | Só `200` quando: DB conectável, migrations aplicadas, WebSocket pronto, recursos críticos OK. Caso contrário `503` com motivo curto. |
| **`GET /health`** (mantido) | Compatibilidade com o monitoramento e probes atuais. | Mantido como está — não quebrar `switch.sh`, probes externos ou dashboards. |

**Vantagem:** durante boot/migrations demorados, o container novo fica
`503 not ready` e o Caddy **nunca** roteia tráfego para ele. Isso torna o switch
determinístico, em vez de depender só de timeout.

> **Regra crítica (já respeitada):** manter `stream_close_delay 5m` em
> `/realtime*` e **não** reintroduzir `lb_retries` no Caddy — repetição de POST
> não-idempotente é o que quebra caixa.

---

## 5. Migrations (zero-downtime)

As práticas atuais estão corretas (expand/contract; o boot falha se a migration
falhar).

| Sugestão | Explicação | Ganho |
|---|---|---|
| **Migrations antes do ready** | Aplicar migrations no boot da instância nova (blue) e só marcar `/readyz` após `migrations_applied=true`. | Garante que tráfego nunca chega a um schema parcialmente aplicado. Formaliza o que já vale hoje ("health verde = schema aplicado"). |
| **Timeouts/locks controlados** | `lock_timeout`/`statement_timeout` para migrations longas; evitar DDL destrutivo em horário de pico. | Reduz risco em produção. |
| **Verificação pós-migration** | Smoke mínimo após o ready, antes do reload do Caddy. | Defesa em profundidade. |

**Inegociável:** a versão antiga precisa continuar compatível com o schema novo
(regra expand/contract já documentada em `docs/agent-deploy.md`).

---

## 6. Smoke tests pós-switch (automatizar a validação manual)

O checklist manual (login → abrir comanda → lançar → cozinha → entregar → pagar
→ fechar) é bom material para virar smoke automatizado.

| Sugestão | O que testar | Onde rodar |
|---|---|---|
| **Smoke mínimo (crítico)** | `GET /readyz` (200), `GET /health`, `GET /auth/users`, login por PIN (garçom e gerente), listar comandas, criação leve de comanda. | Imediatamente após `switch.sh` com sucesso. |
| **Smoke E2E leve (API/Playwright)** | Fluxo ponta-a-ponta curto (abrir comanda + lançar item) contra a URL pública. | Job pós-deploy, com `fail-fast: true`. |
| **Probe de disponibilidade obrigatório** | `probe-availability.sh --url <url> --seconds 10–30` após o switch; **falhar o deploy** se `downtime_gap != 0` (ou > 200–500 ms). | Vira gate obrigatório no pipeline. |

**Recomendação P0:** tornar `probe-availability.sh` obrigatório no passo
pós-switch — a ferramenta já existe, falta apenas torná-la bloqueante.

---

## 7. Rollback automático e manual robusto

`switch.sh --rollback` já existe. O gargalo é **detectar a falha a tempo** para
agir.

| Melhoria | Proposta | Ganho |
|---|---|---|
| **Rollback automático** | Se o smoke falhar **ou** o probe detectar gap/5xx na janela de observação (ex.: 30 s após o reload), rodar `switch.sh --rollback`, notificar e marcar o deploy como **FAILED**. | Reduz MTTR (minutos → segundos); não deixa produção degradada esperando humano. |
| **Janela de observação** | Após o switch, aguardar 10–30 s (warm-up + reconexão de WebSocket) antes do smoke/probe. | Evita falso positivo por reconexão normal de realtime. |
| **Histórico de releases** | Manter as últimas 2–3 imagens/tags e o estado blue/green conhecido; documentar como listar versões para rollback manual. | Rollback manual rápido e auditável. |
| **Auditoria do deploy** | Step Summary com: ambiente, `de → para`, `image@digest`, commit, duração, `probe_gap_ms`, `rollback_executed`. | Rastreabilidade completa. |

> **Escopo do automático:** ativar para **falhas técnicas** (health/readyz 5xx,
> smoke quebrado, probe com downtime). Regressão de negócio/UX/dados continua
> exigindo aprovação humana + alerta.

---

## 8. CI/CD (GitHub Actions) — estrutura recomendada

Três responsabilidades, no mesmo padrão já adotado com `build-desktop.yml`
(uma única definição de build; nunca duplicar em cópia).

| Workflow | Trigger | Responsabilidade |
|---|---|---|
| **`ci.yml`** | PRs e push em `main` | Lint, `tsc`, testes backend/frontend, build do frontend. Configurar como **Required Checks** para proteger `main`. |
| **`build-and-push.yml`** (reusable) | `workflow_call` + push de tag `v*` | Build da imagem do backend → GHCR com tags + digest; exporta `image_ref`/`image_digest`. O desktop continua no workflow único atual. |
| **`deploy.yml`** (reusable + environments) | `workflow_dispatch` (com `environment`, `ref`, `image_ref`) ou chamado após release | Executa `switch.sh` no host, roda smoke + `probe-availability.sh`, aplica rollback automático em falha técnica. |

### Proteção dos ambientes

| Ambiente | Auto-deploy | Aprovações | Wait timer | Concurrency |
|---|---|---|---|---|
| **`staging`** | Sim (tag `-rc*` ou após CI verde) | Opcional | 0 | `group: deploy-staging, cancel-in-progress: true` |
| **`production`** | Não | **≥ 1 revisor** | 0–5 min (alerta pré-deploy) | `group: deploy-prod, cancel-in-progress: false` |

**Regra importante:** em produção, `cancel-in-progress: false` — nunca cancelar
um deploy em andamento. Em staging, `true` para o mais recente vencer.

---

## 9. Segurança, secrets e acesso

| Melhoria | Sugestão | Ganho |
|---|---|---|
| **Secrets por ambiente** | GitHub Environments para segregar `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `DEPLOY_PATH` entre staging e produção. | Isolamento e menor blast radius. |
| **Chave de deploy dedicada** | Chave usada só para deploy, com shell restrito; limitar por host/IP quando possível. | Superfície de ataque menor. |
| **Pin por digest** | Preferir `@sha256` na referência de imagem usada pelo `switch.sh`. | Imutabilidade e replay seguro. |
| **Supply chain** | SBOM + provenance no build. | Rastreabilidade de dependências. |
| **Manter as regras do repo** | Não commitar `.env`, não pular hooks, não force-push (conforme `AGENTS.md`). | Consistência. |

---

## 10. Observabilidade e pós-deploy

| Sugestão | Implementação | Valor |
|---|---|---|
| **Step Summary** | Escrever no `$GITHUB_STEP_SUMMARY`: ambiente, versão, commit, `image_ref`, `image_digest`, duração, `probe_gap_ms`, `rollback_executed`, status. | Visibilidade imediata no run. |
| **Notificações** | Resumo em Slack/Discord (webhook) em sucesso/falha, destacando quando houve rollback automático. | Alerta operacional rápido. |
| **Correlação log ↔ deploy** | Incluir `deploy_id`/versão nos logs da aplicação. | Triagem em logs/APM. |
| **Métricas DORA** | Deployment frequency, lead time, change failure rate, MTTR. | Medir maturidade ao longo do tempo. |

---

## 11. Ajustes propostos no `switch.sh` (backward-compatible)

O script já é sólido. As sugestões abaixo são **parâmetros novos com default
seguro** — não quebram o uso atual.

| Variável | Proposta | Motivo |
|---|---|---|
| `IMAGE_REF` | Aceita `ghcr.io/...@sha256:...` ou tag; vazio = comportamento atual (build local). | Permite promover imagem pré-buildada sem alterar o fluxo existente. |
| `READINESS_URL` | Gate em `/readyz`, com fallback para `/health` se não definida. | Readiness estrito sem quebrar ambientes antigos. |
| `HEALTH_TIMEOUT_SEC` | Separar timeout de startup (boot + migrations) do intervalo de polling. | Evita timeout precoce quando o boot fica mais lento. |
| `STARTUP_GRACE_SEC` | Carência antes do polling agressivo (5–10 s). | Folga para o container abrir sockets/DB. |
| `SKIP_SMOKE` | Pula smoke local quando o CD já roda o seu. | Evita duplicação. |
| `ROLLBACK_ON_FAIL` | Default `false` (manual); o CD pode setar `true`. | Automático só quando explicitamente pedido pelo pipeline. |

> **Não mexer:** sem `lb_retries` no Caddy, `stream_close_delay 5m` em
> `/realtime*`, e a lógica de abortar o switch imediatamente quando a instância
> verde está doente.

---

## 12. Plano de implementação

Aplicar por fases, validando em staging antes de produção.

| Fase | Prioridade | Tarefas | Critério de aceite |
|---|---|---|---|
| **P0 — Fundação** | Alta | 1) `GET /readyz` no backend (readiness estrito; manter `/health`). 2) `probe-availability.sh` como passo obrigatório do `deploy.yml`. 3) GitHub Environments `staging`/`production` + protection rules. | Readiness ≠ liveness; probe bloqueia o deploy; ambientes segregados com aprovação em produção. |
| **P1 — Build once** | Alta | 1) `build-and-push.yml` (build → GHCR, tags + digest). 2) `switch.sh` aceita `IMAGE_REF`. 3) `deploy.yml` promove por `@sha256`. | Staging e produção rodam a **mesma** digest; nenhum build no host de produção. |
| **P2 — Hardening** | Média | 1) Smoke automatizado pós-switch. 2) Rollback automático em falha técnica (`ROLLBACK_ON_FAIL=true`). 3) release-please/changesets para tags e changelog. | Smoke quebrado → rollback automático + workflow FAILED com evidências. |
| **P3 — Observabilidade** | Baixa | 1) SBOM/provenance, cache Buildx, multi-arch se necessário. 2) Notificações Slack/Discord. 3) Métricas DORA. | Ganho de DX/segurança sem risco adicional. |

---

## 13. Recomendação final

Melhor caminho por ROI e risco:

1. **P0** — `/readyz` + `probe-availability.sh` como gate obrigatório. Mudanças
   pequenas, alto impacto, zero disrupção.
2. **P1** — build once + promoção por digest. Elimina o maior ponto de drift
   entre ambientes e viabiliza rollback determinístico.
3. **P2** — smoke pós-switch + rollback automático em falha técnica. Fecha o
   laço **detecta → falha → reverte** sem intervenção manual nos casos óbvios.

**Conclusão:** manter o `switch.sh` como motor atômico de deploy blue/green e
fortalecer o **orquestrador** (Actions + Environments + readiness + probe +
smoke + rollback automático) ao redor dele.

A fórmula: **build once, deploy the same artifact, verify with real probes +
automated smoke, auto-rollback on technical failure** — o melhor equilíbrio entre
segurança, simplicidade e zero-downtime para este projeto.