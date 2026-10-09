# PDV — Restaurante/Pub

Sistema de ponto de venda para restaurantes e pubs. Este repositório é um monorepo com backend, interfaces web, apps Tauri, gateways e ferramentas de operação.

## Comece por aqui

- **Pessoa desenvolvedora:** [`CONTRIBUTING.md`](CONTRIBUTING.md) → [setup e comandos](scripts/README.md).
- **Agente de código:** [`AGENTS.md`](AGENTS.md) → [índice por tarefa](docs/README.md). Leia somente os guias da área que será alterada.
- **Deploy/operação:** [`deploy/README.md`](deploy/README.md) e [`docs/agent-deploy.md`](docs/agent-deploy.md).
- **Histórico de releases:** [`CHANGELOG.md`](CHANGELOG.md).

> Para confirmar se um comportamento está implementado, confira código, testes, manifests e workflows atuais. Specs e planos podem registrar intenção ou histórico, não necessariamente o estado do produto.

## Mapa do repositório

| Caminho | Responsabilidade |
|---|---|
| `backend/` | API Node.js/TypeScript, PostgreSQL, REST e realtime |
| `frontend/` | Aplicação React/Vite compartilhada pelas entradas web e desktop |
| `apps/pedido-public/` | Aplicação pública de pedidos |
| `standalone-*`, `standalone-shared/` | Aplicativos e código compartilhado Tauri/Rust |
| `ws-gateway/` | Gateway realtime em Go |
| `pagarme-webhook/` | Serviço Go de webhook Pagar.me |
| `cmd/pdv/` | Código-fonte da CLI Go |
| `deploy/`, `scripts/` | Deploy, build e ferramentas de desenvolvimento |
| `docs/` | Specs, contratos, guias por área e índice de documentação |

Os apps mobile React Native/Expo são mantidos em outro repositório; aqui ficam os contratos que consomem, não o código mobile.

## Desenvolvimento e validação

Os comandos e pré-requisitos variam por componente. Consulte os guias locais: [scripts e fluxo de desenvolvimento](scripts/README.md), [backend](docs/agent-backend.md), [frontend](frontend/docs/agent-frontend.md), [testes](docs/agent-testing.md) e [deploy](deploy/README.md). Execute validações do componente alterado e revise `git diff`. Não use operações de deploy ou banco de produção como validação local.

## Documentação

O [`docs/README.md`](docs/README.md) é o índice central. Ele diferencia guias práticos, especificações, contratos e documentos de planejamento/histórico, e orienta como resolver divergências.
