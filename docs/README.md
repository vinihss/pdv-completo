# Índice da documentação

Este índice é a porta de entrada para pessoas e agentes. Comece pelo objetivo da tarefa, leia o guia prático e só então carregue a spec ou o contrato específico necessário. Não é necessário ler todo o diretório.

## Caminhos rápidos

| Objetivo | Comece por | Consulte também |
|---|---|---|
| Entender produto e critérios | [Visão geral](00-overview.md) | [Critérios de aceite](03-acceptance-criteria.md), specs de produto abaixo |
| Rodar/contribuir | [README](../README.md), [CONTRIBUTING](../CONTRIBUTING.md) | [Scripts](../scripts/README.md) |
| Alterar API/backend | [Guia backend](agent-backend.md) | [Mapa backend](agent-backend-map.md), [índice da API](agent-api-index.md), [guia de migrations](../backend/migrations/README.md) |
| Alterar interface React | [Guia frontend](../frontend/docs/agent-frontend.md) | [Mapa frontend](agent-frontend-map.md), [testes frontend](../frontend/docs/agent-testing.md) |
| Testes e validação | [Guia de testes](agent-testing.md) | scripts e workflows do componente |
| Deploy/operação | [Guia deploy](agent-deploy.md) | [Runbook deploy](../deploy/README.md) |
| PostgreSQL/dados | [Manutenção de banco](agent-db-maintenance.md) | Esclareça ambiente/autorização antes de qualquer operação real |
| Impressão/ESC-POS | [Guia de impressão](agente-hardware-printing.md) | Código, testes golden e configuração do app em uso |
| Termos e contratos | [Glossário](agent-glossary.md), [índice API](agent-api-index.md) | Specs da integração específica |
| Apps Tauri/Rust | `standalone-*` e [`Cargo.toml`](../Cargo.toml) | README do crate e instruções locais do diretório |
| Gateway Go | [`ws-gateway/GO-GATEWAY-PLAN.md`](../ws-gateway/GO-GATEWAY-PLAN.md) | `ws-gateway/` e deploy atual |
| Webhook Pagar.me | [`pagarme-webhook/GO-PAGARME-PLAN.md`](../pagarme-webhook/GO-PAGARME-PLAN.md) | Código/tests em `pagarme-webhook/` |

> Os apps mobile React Native/Expo estão em um repositório separado. Evite links para cópias locais (`~/Downloads/...`), que não são válidas para todos os leitores.

## Guias práticos

- **Backend:** [`agent-backend.md`](agent-backend.md), [`agent-backend-map.md`](agent-backend-map.md), [`agent-api-index.md`](agent-api-index.md).
- **Frontend:** [`frontend/docs/agent-frontend.md`](../frontend/docs/agent-frontend.md), [`agent-frontend-map.md`](agent-frontend-map.md); o mapa deve ser conferido contra o código atual.
- **Testes:** [`agent-testing.md`](agent-testing.md) e [`frontend/docs/agent-testing.md`](../frontend/docs/agent-testing.md).
- **Operação:** [`agent-deploy.md`](agent-deploy.md), [`agent-db-maintenance.md`](agent-db-maintenance.md), [`agente-hardware-printing.md`](agente-hardware-printing.md).

## Specs, contratos e decisões

| Documento | Assunto |
|---|---|
| [`00-overview.md`](00-overview.md) | Visão do produto |
| [`01-backend-spec.md`](01-backend-spec.md), [`02-frontend-spec.md`](02-frontend-spec.md) | Specs de backend e interface |
| [`03-acceptance-criteria.md`](03-acceptance-criteria.md) | Critérios verificáveis de aceite |
| [`04-cash-flow.md`](04-cash-flow.md) | Fluxo de caixa |
| [`07-estoque.md`](07-estoque.md), [`08-estoque-profissional.md`](08-estoque-profissional.md) | Estoque, compras e custos |
| [`11-desktop-instalador.md`](11-desktop-instalador.md) | Instalador e atualização desktop |
| [`17-runbook-unificacao-migrations.md`](17-runbook-unificacao-migrations.md) | Runbook de migrations |
| [`25-admin-server-tui.md`](25-admin-server-tui.md) | Plano do admin server (Go, no host) + TUI remota de administração — **plano, não implementado** |
| [`26-identidade-centralizada.md`](26-identidade-centralizada.md) | Identidade centralizada: novo login (email/senha), seleção de empresa, invite — **plano aprovado em implementação**; registra a decisão por schema único + RLS (workstream B) |

### Documentos removidos em `308c9977` (recuperar com `git show 308c9977^:docs/<arquivo>`)

`04-delivery-self-service-integration.md`, `05-delivery-api-contracts.md`,
`06-ifood-integration.md`, `09-frontend-fsd.md`, `11-pix-pendencias.md`,
`12-n-plus-one-list-orders.md`, `13-deploy-workflow-melhoras.md`,
`14-usabilidade-e-processos.md`, `15-multi-tenant-schema.md`,
`18-ifood-por-loja.md`, `19-pagarme.md`, `20-pagarme-pendencias.md`,
`21-device-provisioning.md`, `22-mobile-react-native.md`,
`23-reavaliacao-multi-tenant.md`, `dicionario-japones.md`,
`lista-produtos-*`, `alteracoes-produtos-*`, `multi-tenant-login-correcao.md`
e outros planos/históricos.

Antes de citar qualquer um deles em doc ou código, confira se o conteúdo ainda
vale: são contexto histórico. A direção vigente de identidade/multi-tenant está
em `26-identidade-centralizada.md`; convenções atuais de backend/frontend nos
guias `agent-*`.

## Planejamento e histórico não são estado implementado

Documentos com termos como plano, pendências, roadmap, melhorias ou histórico registram propostas, decisões ou contexto temporal. Antes de tomar uma afirmação como comportamento atual, valide no código, testes e configuração. Isso também vale para changelogs e planos de componentes.

## Como resolver divergências

1. Para comportamento e comandos atuais: código, testes, manifests, scripts e CI.
2. Para intenção de produto: spec e critérios de aceite relevantes.
3. Guias práticos orientam o trabalho e apontam para detalhes; não substituem validação do estado atual.
4. Se o conflito puder mudar comportamento, contrato, segurança ou dados, registre evidências e não escolha silenciosamente.

## Manutenção do índice

Ao adicionar, renomear ou remover documentação, atualize este índice e as instruções de entrada relevantes. Prefira links relativos dentro do repositório; não use caminhos locais da máquina do autor. Evite duplicar comandos, versões, contagens de testes e estado de produção: aponte para a fonte executável mais próxima.
