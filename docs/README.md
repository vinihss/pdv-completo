# Índice da documentação

Este índice ajuda pessoas e agentes a encontrar a fonte adequada sem carregar toda a documentação do projeto.

## Comece por aqui

| Objetivo | Leia primeiro | Próximo passo |
|---|---|---|
| Entender o produto | [`00-overview.md`](00-overview.md) | [`03-acceptance-criteria.md`](03-acceptance-criteria.md) |
| Rodar o projeto localmente | [`../README.md`](../README.md) | [`../scripts/README.md`](../scripts/README.md) |
| Alterar backend/API | [`agent-backend.md`](agent-backend.md) | [`agent-backend-map.md`](agent-backend-map.md), [`agent-api-index.md`](agent-api-index.md) |
| Alterar interface web | [`agent-frontend.md`](agent-frontend.md) | [`agent-frontend-map.md`](agent-frontend-map.md) |
| Alterar app mobile | repo separado **`pdv-mobile-apps`** (`~/Downloads/pdv-mobile-apps`) — [`README.md`](../../pdv-mobile-apps/README.md) | [`22-mobile-react-native.md`](../../pdv-mobile-apps/docs/22-mobile-react-native.md) (saiu deste repo junto com `mobile/`) |
| Escrever/selecionar testes | [`agent-testing.md`](agent-testing.md) | Specs da área afetada |
| Alterar deploy ou investigar operação | [`agent-deploy.md`](agent-deploy.md) | [`../deploy/README.md`](../deploy/README.md) |
| Alterar impressão | [`agente-hardware-printing.md`](agente-hardware-printing.md) | Renderizador Rust em [`standalone-pdv/src/printing/`](../standalone-pdv/src/printing/) (o daemon Go saiu deste repo) |
| Manter banco de dados | [`agent-db-maintenance.md`](agent-db-maintenance.md) | Leia os limites de segurança antes de qualquer acesso |
| Entender termos do domínio | [`agent-glossary.md`](agent-glossary.md) | — |

## Documentos por categoria

### Produto e critérios

- [`00-overview.md`](00-overview.md) — visão geral e decisões de produto.
- [`01-backend-spec.md`](01-backend-spec.md) — modelo de domínio e contratos técnicos.
- [`02-frontend-spec.md`](02-frontend-spec.md) — fluxos e comportamentos de interface.
- [`03-acceptance-criteria.md`](03-acceptance-criteria.md) — critérios verificáveis de aceitação.
- [`14-usabilidade-e-processos.md`](14-usabilidade-e-processos.md) — backlog de usabilidade e processos.

### Guias de trabalho

- [`agent-backend.md`](agent-backend.md) e [`agent-backend-map.md`](agent-backend-map.md)
- [`agent-frontend.md`](agent-frontend.md) e [`agent-frontend-map.md`](agent-frontend-map.md)
- [`agent-testing.md`](agent-testing.md)
- [`agent-deploy.md`](agent-deploy.md)
- [`agent-api-index.md`](agent-api-index.md)
- [`agent-glossary.md`](agent-glossary.md)
- [`agent-db-maintenance.md`](agent-db-maintenance.md)
- [`agente-hardware-printing.md`](agente-hardware-printing.md)

### Integrações, arquitetura e componentes

- [`04-delivery-self-service-integration.md`](04-delivery-self-service-integration.md), [`05-delivery-api-contracts.md`](05-delivery-api-contracts.md)
- [`06-ifood-integration.md`](06-ifood-integration.md), [`18-ifood-por-loja.md`](18-ifood-por-loja.md)
- [`10-whatsapp-embedded-signup.md`](10-whatsapp-embedded-signup.md)
- [`15-multi-tenant-schema.md`](15-multi-tenant-schema.md)
- [`19-pagarme.md`](19-pagarme.md), [`20-pagarme-pendencias.md`](20-pagarme-pendencias.md)
- [`21-device-provisioning.md`](21-device-provisioning.md) — o doc 22 (migração RN dos apps mobile) saiu deste repo e está em `~/Downloads/pdv-mobile-apps/docs/22-mobile-react-native.md`
- [`11-desktop-instalador.md`](11-desktop-instalador.md)
- [`../ws-gateway/GO-GATEWAY-PLAN.md`](../ws-gateway/GO-GATEWAY-PLAN.md)

### Histórico, planos e pendências

Arquivos cujo título contém “pendências”, “plano”, “roadmap”, “melhoras” ou “histórico” podem descrever trabalho futuro ou decisões passadas; não os trate automaticamente como comportamento implementado. Confirme o estado no código, testes e workflows atuais.

Exemplos: [`11-pix-pendencias.md`](11-pix-pendencias.md), [`12-n-plus-one-list-orders.md`](12-n-plus-one-list-orders.md), [`13-deploy-workflow-melhoras.md`](13-deploy-workflow-melhoras.md), [`16-pendencias.md`](16-pendencias.md), [`17-runbook-unificacao-migrations.md`](17-runbook-unificacao-migrations.md).

## Como interpretar e resolver divergências

1. Para **comportamento implementado e comandos**, confira código, testes, `package.json`, scripts e CI atuais.
2. Para **intenção de produto**, consulte a spec e os critérios de aceite relevantes.
3. Guias `agent-*` resumem práticas; siga os links para o detalhe canônico da área.
4. Planos, changelog e documentos explicitamente históricos não são prova de que algo está implementado.
5. Se uma divergência puder mudar comportamento, segurança, dados ou contrato, não escolha silenciosamente: registre o conflito e peça decisão ou evidência ao responsável.

## Manutenção

Ao alterar contrato, arquitetura, comandos ou procedimento operacional, atualize o guia canônico da área e os links de entrada afetados. Evite copiar números de suítes, versões e estados de produção: prefira comandos de descoberta ou indique a data de revisão. Documentos operacionais devem registrar pré-condições, impacto, validação e rollback.
