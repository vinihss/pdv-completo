# Migrations PostgreSQL

Esta pasta contém três áreas com papéis distintos. O SQL é parte do contrato de implantação; não renomeie, mova ou reordene migrations já publicadas.

## Mapa

| Local | Papel | Runner |
|---|---|---|
| `*.sql` diretamente nesta pasta | Cadeia de schema de negócio aplicada em cada schema de tenant (incluindo `public`) | `src/infra/db/migrate.ts` / `npm run db:migrate` |
| `registry/*.sql` | Schema global de controle de tenants, sempre em `public` | `src/infra/db/registry-migrate.ts` / `npm run db:migrate:registry` |
| `archive/*.sql` | Cadeia histórica substituída pelo baseline consolidado; apenas referência | Nenhum; não é executado |

O runner principal lê **somente arquivos `.sql` diretamente nesta pasta**, ordena pelo nome e grava o filename completo em `_migrations.name` no próprio schema. O runner do registry grava em `public._registry_migrations`. A separação de pastas é intencional: não mova arquivos entre essas áreas.

## Cadeia ativa do runner principal

A lista abaixo reflete o checkout atual; confirme os arquivos antes de cada mudança. A ordem de execução é lexical.

| Ordem | Arquivo ativo | Tema |
|---:|---|---|
| 1 | `0001_init.sql` | Baseline consolidado do schema de negócio |
| 2 | `0003_courier_location.sql` | Última localização do entregador |
| 3 | `0004_delivery_arrival_alert_sent.sql` | Controle do alerta de chegada |
| 4 | `0004_device_provisioning.sql` | Chaves e dispositivos provisionados |
| 5 | `0005_cash_drawer_denominations.sql` | Fechamento de caixa com contagem por denominação |
| 6 | `0006_order_refund.sql` | Tabela `order_refund` — estorno de linhas de pagamento |
| 7 | `0008_cash_movement_category.sql` | Categoria de sangria/suprimento + alçadas |
| 8 | `0009_remove_whatsapp.sql` | Remoção da integração WhatsApp |
| 9 | `0010_remove_payment_ifood.sql` | Remoção da camada de pagamento online (Pagar.me) e do iFood |
| 10 | `0011_delivery_gis.sql` | PostGIS, regiões geográficas, geofencing e rotas OSRM |

`0002_pagarme.sql` (cobranças, inbox do webhook e estornos do gateway) e
`0007_order_settlement.sql` (repasse de marketplace) foram removidos da cadeia
ativa junto com o código de pagamento online e a integração iFood. Instalações
que já aplicaram essas migrations são limpas por `0010_remove_payment_ifood.sql`
(payment/payment_event/payment_refund, order_settlement, ifood_event/ifood_state
e as colunas ifood/pagarme de `order`, `product` e `store_settings`); em banco
novo a 0010 é no-op.

`0009_remove_whatsapp.sql` derruba `whatsapp_connection`, `whatsapp_conversation`,
`whatsapp_inbound_message` e `whatsapp_outbound_message`, os enums `whatsapp_*`,
a coluna `store_settings.whatsapp_integration_enabled` e `delivery.arrival_alert_sent`
(a coluna só existia para marcar o alerta "sua entrega está chegando", que era
mensagem de WhatsApp). O valor `'whatsapp'` do enum `channel` **permanece**, por
compatibilidade de leitura de pedidos antigos — é read-only no código. Pela
mesma razão, `0010` mantém o valor `'ifood'` do enum `channel`.

Os dois nomes `0004_*` são uma colisão histórica já implantada; a ordenação lexical atual executa `delivery_arrival_alert_sent` antes de `device_provisioning`. **Não renomeie nenhum dos dois**. Para migrations novas, use um prefixo numérico lexicograficamente posterior ao maior existente (no estado atual, `0012_*`) e evite reutilizar prefixos.

## Regras para mudanças futuras

1. Adicione um novo arquivo incremental na raiz, com prefixo novo, maior e zero-padded; nunca reescreva o baseline para refletir mudanças depois que ele foi publicado.
2. O filename é a identidade persistida da migration. Mantê-lo estável é necessário para que ambientes existentes reconheçam o que já foi aplicado.
3. O runner executa cada arquivo em transação com advisory lock por schema. Escreva DDL compatível com rollout/retentativa (`IF NOT EXISTS` quando adequado) e considere bancos que podem ter drift parcial.
4. Não use `CREATE INDEX CONCURRENTLY` no runner transacional. Para operações incompatíveis com transação, planeje um mecanismo separado e documente a execução/recuperação.
5. `registry/` é exclusivo para DDL global com runner próprio; migrations de negócio não devem ir para lá. `archive/` não é uma pasta de execução.
6. Atualize este índice, `docs/agent-backend.md` e testes/documentação que afirmem a lista exata. Teste os dois runners e a criação de tenant quando o escopo afetar esses caminhos.

## Registry de tenants

`registry/0001_tenant_registry.sql` é aplicado antes da cadeia principal no boot. Ele cria estruturas de controle em `public`; nunca deve ser aplicado dentro do schema de cada loja. Leia os comentários do SQL e `src/infra/db/registry-migrate.ts` antes de mexer.

## Arquivo histórico

`archive/` guarda a antiga sequência de migrations e as mudanças de consolidação. Ela não é um diretório de migrations pendentes. O estado de banco após o baseline não se deduz da árvore histórica: confira `_migrations` e os procedimentos de implantação autorizados, sem consultar produção sem autorização explícita.
