# 14 — Usabilidade e processos: fluxo de pedido, gestão e caixa

Este documento é uma **proposta**, não implementação. Nada aqui foi escrito no
código, nenhuma migration foi criada, nenhum endpoint novo existe. É um backlog
analisado e priorizado: cada item é uma decisão que ainda precisa ser tomada,
com esforço estimado e impacto esperado.

A lista também inclui **bugs** (Tier 0) — não coisas "melhoráveis", e sim
defeitos que quebram invariantes do sistema: receita de marketplace
contaminada, estorno que desaparece do faturamento, salas de realtime mortas,
endpoints documentados que não existem. Esses itens são barreiras de
confiabilidade e **têm de vir antes de qualquer tela nova**. Uma tela bonita
sobre um caixa que mente é pior que nenhuma tela.

---

## Diagnóstico executivo

### O que já está forte (não mexer)

Antes de propor, o que já funciona bem e não deve ser reescrito:

| Área | Realidade |
|---|---|
| Ordem do código | FSD, server-authoritative, lock otimista com `expectedVersion`, idempotência por `correlationId`, outbox pattern, `npm run build`+`test` como portão |
| Overlays | `Modal`/`Drawer`/`ConfirmModal` com dono, focus trap, swipe-to-dismiss, Esc em pilha — acima da média |
| Caixa | Fórmula do esperado **recalculada** (nunca denormalizada), sessão única garantida por índice parcial no banco, estorno automático com `ref_order_id` rastreável |
| Cozinha | FIFO, urgency colorida, nota do pedido em destaque, grouping por estação |
| Integrações | iFood e WhatsApp **reais** (não stub), impressora com spooler em BoltDB |
| Unificação web/standalone | **Já é verdade**: os 4 apps Tauri consomem o mesmo bundle React (`build:pdv\|kds\|garcon\|entregador`). Não há lógica duplicada entre web e nativo. |

O achado mais importante do diagnóstico é o da última linha: a decisão
arquitetural mais cara e mais discutida em projetos deste porte (separar app
nativo de app web) **já está tomada e já está no repo**. Não há duas bases de
código para manter em sincronia. Qualquer proposta de usabilidade vale para
os dois surfaces de graça.

### Os 5 gargalos estruturais

**1. O modelo de pedido é fino demais para operação real.**
`orderStatus = {open, closed, cancelled}` (`backend/src/infra/db/schema.ts:52`) e todo o estado vive no item (`ordered→ready→delivered`). Não existe "em preparo" na comanda, não existe `expeditor`, não existe checkout parcial, não existe dividir/juntar/transferir. O garçom acumula garçom + entregador + caixa.

**2. Não há como estornar dinheiro — só cancelar a venda.**
`DELETE /orders/:id/payments/:paymentId` remove linha não confirmada. O único caminho com efeito no caixa é `PATCH /orders/:id/cancel`, manager-only, que muda `status='cancelled'` — e o relatório de vendas só lê `closed` (`backend/src/application/report.usecases.ts`). Resultado: a venda desaparece do faturamento e a sangria fica só no caixa. Não há linha negativa. Não há refund de Pix/cartão. `cancelOrder` também falha com 409 de gaveta quando o cancelamento vem do cliente (`backend/src/application/self-service/cancel-order.usecase.ts:50` reusa o mesmo usecase com `SYSTEM_USER_ID`).

**3. Receita de marketplace está contaminada.**
`backend/src/integrations/ifood/status-pushback.ts:90-101` insere `order_payment` direto no banco com o valor bruto total do iFood, sem passar por `requireOpenDrawerForCash` (`order.usecases.ts:549`). O relatório soma o bruto como receita; o caixa recebe o bruto; o repasse real é bruto − comissão − taxa. Três números diferentes para o mesmo pedido. Não existe entidade de comissão/settlement no repo.

**4. Não existe turno nem DRE.**
A sessão da gaveta é o turno implícito: não amarra operador, não tem data de operação, e o summary filtra sessão por interseção — uma sessão que cruza a meia-noite aparece em dois dias (`backend/src/application/cash-flow/cash-flow.usecases.ts:375-380`).

**5. Realtime com 2 salas mortas e sem agregação.**
- `table:{id}`: 14 emissões (`order.usecases.ts:240,450,524,630,673,705,741,800,806,920,926` + `status-pushback.ts:124,164`), zero assinantes no frontend.
- `waiter:{id}`: o frontend assina (`frontend/src/widgets/order-board/useOrders.js:58`), zero emissões no backend. O garçom funciona de fato pelo `kitchen-display`, ou seja recebe payload de comandas de outros ERKs.
- Não existe atualização de `waiterId` (gravado na abertura, nunca muda) → não há transferência de comanda.

---

## Tier 0 — Bugs de confiabilidade

Não são melhorias. São defeitos com evidência no código. Cada um deveria virar
correção pequena e separada, na ordem da dependência.

1. **iFood ignora o hard block de gaveta** — `status-pushback.ts:90-101` insere pagamento direto; pedido pago em dinheiro entra no `expected` sem gaveta aberta. Quebra a invariante do `docs/04-cash-flow.md` que vale para todos os outros caminhos.
2. **`confirmedAt` do iFood é o momento do webhook**, não da venda (`computeCashSummary` filtra por `confirmed_at`) → se chegar com gaveta fechada, o pagamento cai fora da janela `[opened_at, closed_at]` e a venda aparece no relatório mas não no caixa.
3. **Estorno some do faturamento** — vendas lê `status='closed'`; cancelado vira `'cancelled'`.
4. **Cancelamento pelo cliente pode falhar com 409 de gaveta** — `cancel-order.usecase.ts:50`.
5. **Salas mortas** — 14 emissões em `table:{id}` sem assinante; `waiter:{id}` assinado sem emissão.
6. **`PUT /orders/:id/payments` + confirm + remove não são idempotentes** (`order.routes.ts:165-192`) — os três endpoints mais usados do caixa.
7. **Endpoints documentados e inexistentes** — `PATCH /orders/:id/status`, `POST /tables` e `PATCH /tables/:id` não existem no backend. **A documentação já foi corrigida**: saíram de `docs/agent-api-index.md` e do cabeçalho de `order.routes.ts`. O que resta é a decisão de produto da seção *Endpoints documentados e ainda não implementados* (abaixo): implementar as rotas ou aceitar que não existem. Enquanto isso, quem precisar da capacidade usa o que existe — `PATCH /orders/:id/close` e `PATCH /orders/:id/cancel` no lugar de "mudar status"; `/tables` é só leitura.
8. **`CHANGELOG.md` diz que o N+1 de `listOrders` está pendente e o código já está resolvido** (`order.usecases.ts:971-1081` faz batch) — `docs/12-n-plus-one-list-orders.md` está defasado.

Os itens 6 e 7 são os mais traps de todos: são bugs de *documentação contra
código* que não se manifestam como erro em produção, e sim como trabalho
desperdiçado de quem implementa contra o índice de API.

### Endpoints documentados e ainda não implementados

O `docs/agent-api-index.md` prometeu estes endpoints e nenhuma rota no backend
os atende. Eles foram **removidos do índice** — um endpoint que não existe não
fica listado como se existisse, nem com nota. O registro fica aqui, porque
alguém vai precisar criá-los e não deve redescobrir a lacuna do zero.

| Endpoint | O que faria | O que existe hoje no lugar |
|---|---|---|
| `PATCH /orders/:id/status` | Trocar o status da comanda (`open`/`closed`/`cancelled`) por uma rota genérica | `PATCH /orders/:id/close` (waiter, manager) e `PATCH /orders/:id/cancel` (manager, só sem venda). Cobrem os dois estados terminais, mas não há rota única de transição. |
| `POST /tables` | Criar mesa | Nada. `/tables` é só leitura (`listTablesUsecase`) e as mesas vêm do seed/migration. |
| `PATCH /tables/:id` | Editar mesa (identificação, status, ocupação) | Nada. Sem rota de escrita, uma mesa criada fora do seed não tem como entrar no sistema por API. |

O índice tinha outras linhas que não correspondiam a rota nenhuma, mas que
**não** indicam functionality faltando — eram nomes errados para o que já
existe. Também foram corrigidas: `GET /kitchen/orders` e `PATCH
/kitchen/orders/:id/items/:itemId/ready` (a cozinha não tem rota própria — o KDS
usa `GET /orders?status=open` e `PATCH /orders/:id/items/:itemId` com
`status: "ready"`), `GET /public/orders/:id` (existem `/public/orders/:id/status`
e `POST /public/orders/active`), `POST /whatsapp/connect` (existe `POST
/whatsapp/embedded-signup/exchange`) e `GET /whatsapp/history` (existe `GET
/whatsapp/messages`). Quem for implementar contra a API deve conferir a rota
no código, não pelo nome antigo.

A implementação de qualquer linha desta tabela é decisão de produto e vai em
PR próprio, com rota, validação, `audit_log` e suíte — não junto com ajuste de
documentação.

---

## Camada A — Domínio do pedido (pré-requisito de tudo)

**Legenda de esforço:** S ~ meio dia · M ~1-2 dias · G ~1-2 semanas. A mesma
escala vale para as camadas B a H.

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| A1 | **Colunas de tempo na comanda.** `prep_started_at`, `first_ready_at`, `ready_at`, `served_at`, `billed_at`, `closed_at`. Sem nova máquina de estado e sem risco — destrava todo o capítulo de SLA, tempo médio e relatório de gargalo. Hoje nenhum desses tempos é lido, embora sejam deriváveis de `order_item.created_at/updated_at`. | S | Altíssimo |
| A2 | **Checkout parcial (fechar parte da conta).** Hoje `closeOrderUsecase:781-790` exige todos os itens `delivered`. Cenário real: uma pessoa numa mesa de 4 paga e sai, o resto continua. Criar `order_checkout` (order_id, linhas de item, payments, valor, quem) e fechar só esse checkout, mantendo a comanda aberta. | G | Altíssimo |
| A3 | **Dividir / Juntar / Transferir.** Hoje nenhum backend existe (o que existe é pagamento fracionado, não comanda dividida). Propor `POST /orders/split` (itens em N comandas ligadas por `parent_order_id`), `POST /orders/:id/merge`, `PATCH /orders/:id/assign-waiter`, `PATCH /orders/:id/move-table`. Todas com broadcast + idempotência. | M | Alto |
| A4 | **Estorno de verdade.** Tabela `order_refund` (payment_id, amount, method, reason, authorized_by, external_ref, status) + `POST /orders/:id/refunds`. Dinheiro → sangria com `ref_order_id` (reaproveita mecanismo existente). Pix/cartão → refund pending entra numa fila de conciliação. E corrigir o relatório: venda estornada deve ser linha negativa, preservando faturamento bruto. | G | Altíssimo |
| A5 | **Prazo de validade de comanda.** Sem `expires_at`, comanda esquecida de 4 dias aparece no caixa. `POST /orders/:id/expire` (manager) → estorno automático + alerta. | S | Médio |

Sem A1-A5, otimizar tela é polir o que não anda: cada item do A2/A3 muda a
semântica de fechamento, e A1 é condição para todo relatório de tempo.

## Camada B — Fluxo de pedido (garçom)

O garçom é o usuário de maior volume de toques. Aqui o ganho é redução de
toques por item, sem toque em nada que envolva dinheiro.

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| B1 | **"Repetir comanda anterior"** — maior ROI da lista. Cliente pede "o mesmo de ontem": `POST /orders/:id/repeat-from {orderId}` copia itens com variações. Mata a digitação manual inteira. | S | Altíssimo |
| B2 | **"Comanda rápida"**: o FAB `+` já abre seleção de mesa/cliente E o `AddItemScreen` junto. Hoje são NewOrderModal → criar → OrderDetailScreen → "Adicionar item" → AddItemScreen. | S | Alto |
| B3 | **Atalhos fixos no topo do `AddItemScreen`**: top 8 por frequência real da loja + "últimos pedidos por cliente". Hoje o garçom sempre busca texto. | S | Altíssimo |
| B4 | **Botão `+` no card de produto**: 1 toque lança 1 e volta (batch). Hoje é tap → carrinho → "Revisar e confirmar". Manter a revisão, mas puxada-acima em vez de modal obrigatório para lote de 1. | M | Alto |
| B5 | **"Servir tudo junto"** por comanda: flag que o KDS lê como bloco único de produção/entrega. Hoje pedido de 6 itens chega como 6 tickets independentes e a cozinha decide arbitrariamente a ordem. | S | Alto |
| B6 | **Contador de tempo na comanda**: "mesa 4 aberta há 1h12". Hoje só caixa e cozinha têm cronômetro; o garçom não tem incentivo temporal. | S | Alto |

## Camada C — Gestão do pedido (operação)

Camada que reduz o gargalo **físico** hoje: o garçom indo ao balcão buscar o
prato porque não existe quem entregue.

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| C1 | **Perfil `expeditor` + tela Passe.** Não existe (`userRole` = waiter, kitchen, manager, courier, system, cashier em `schema.ts:48`). Sem expedidor, o garçom é obrigado a ir ao balcão buscar o prato. Tela: prontos em ordem de chegada, timer de SLA, 1 toque = "serviu" (marcando `delivered`). Padrão iFood/Anotaí. Novo room `expedicao`. | G | Altíssimo |
| C2 | **KDS: separar por canal.** Hoje iFood, WhatsApp, web e salão caem no mesmo grid (`KitchenDisplay.jsx` agrupa só por `kitchenGroupId`). Num volume de delivery o garçom de mesa não acha o pedido. Chip de canal + filtro "Só salão / Só delivery". | S | Altíssimo |
| C3 | **KDS: "chamar de volta" (recall).** Prato pronto que o cliente devolve precisa voltar a `ordered`. Hoje só há `ordered→ready→delivered`, sem volta. | S | Alto |
| C4 | **Itens sem dono.** Item sem `kitchen_group_id` não entra em nenhuma estação e, como `ready` é rejeitado sem cozinha, nasce `delivered` e ninguém produz. Com 1 KDS + bar, metade do menu é invisível. Resolver com estação explícita (bar/cozinha/passe) e default por categoria. | M | Alto |
| C5 | **Painel do salão (mapa de mesas).** `GET /tables` devolve `free/occupied/closing` e `closing` não é usado em lugar nenhum. TV do dono: mesa colorida por etapa (livre / aberta Xmin / em preparo / pronta / conta pedida / fechada), fila de delivery, ticket médio ao vivo. Hoje não existe painel de salão. | M | Alto |
| C6 | **Gestão de mesas** — `POST /tables` e `PATCH /tables/:id` documentados mas inexistentes; mesas são fixture de seed. | S | Médio |

C2 e C4 valem menção separada porque são bugs disfarçados de feature: C2 é uma
feature (filtro), mas o custo real é de **erro de operação**; C4 é uma falha
silenciosa de catálogo.

## Camada D — Caixa & financeiro

Onde mora o maior risco do projeto. Se o financeiro mente, nenhuma decisão de
gestão tomada sobre os relatórios é confiável.

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| D1 | **Separar receita bruta de repasse líquido no canal.** migration `order_settlement` (channel, gross, commission, marketplace_fee, payout, payout_status). `order_payment` do canal reflete payout; comissão vira despesa. Resolve o gargalo 3. | G | Crítico |
| D2 | **DRE por dia de operação.** Vendas brutas / descontos / cancelamentos / taxas de marketplace / líquido / CMV / margem / por forma de pagamento. Hoje não existe. | G | Altíssimo |
| D3 | **Consertar a sessão que cruza meia-noite.** Adicionar `business_date` explícito e quebrar por data de operação em vez do filtro por interseção. | S | Alto |
| D4 | **Contagem de caixa por cédula.** Hoje o caixa digita o total contado (`CloseCashDrawerModal.jsx`) e o sistema calcula a diferença. Digitar R$ 1.847,00 é origem nº1 de divergência. Contagem por denomination (200/100/50/20/10/5/2/1 + moedas) com total automático. | M | Altíssimo |
| D5 | **Ampliar meios de pagamento.** `paymentMethod = {cash, card, pix, other}` — card não distingue débito de crédito, não há parcelamento, não há maquininha. Num pub isso significa não saber quanto caiu na maquininha. Estender + `installments`, `acquirer_ref`. | M | Alto |
| D6 | **Transferência entre gavetas.** `cashMovementType` só tem sangria/suprimento. Pub com 2 caixas não consegue transferir. Adicionar `transfer` + `to_drawer_id`. | S | Médio |
| D7 | **Fechamento com trava.** `next_count_due_at` a cada 2h + justificativa obrigatória acima do limite de divergência. Transforma processo em regra do sistema. | M | Alto |
| D8 | **Correção do Pix pendente**: `margin: 1` → `4` (quiet zone em `frontend/src/entities/payment/ui/PixQrScreen.jsx`) e **Pix copia-e-cola** (falta o fallback quando o cliente não escaneia). Dois itens de ~20 linhas que resolvem parte relevante dos "não funcionou" (`docs/11-pix-pendencias.md` §3.3-3.4). | S | Alto |

## Camada E — Canais (nível iFood/Anotaí)

Hoje iFood é worker in-process colado ao pedido; cada canal novo seria
copy-paste. A camada E é sobre transformar iFood em *um canal entre vários*.

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| E1 | **Hub de canais.** Interface `ChannelAdapter { poll(), ack(), pushStatus(), pushCatalog(), mapOrder() }` + tabela `channel_connections`. `ifood/worker.ts` vira a primeira implementação, não caso especial. Adicionar Anotaí/Rappi/99Food passa a ser adapter + config. | G | Estratégico |
| E2 | **Painel de Canais**: saúde por canal (último poll, erro, pedidos/dia, receita bruta, comissão, líquido, % falha). Hoje o único sinal é `lastPollError` escondido em KV (`ifood/state.ts`). | M | Alto |
| E3 | **Preço e disponibilidade por canal.** `product_channel (channel, price, available, sku, sync_status)`. Hoje `product.active` é global — não dá para tirar o prato do iFood mantendo no balcão. | M | Alto |
| E4 | **Tempo estimado real no app do cliente.** `deliveryPrepMinutes` é fixo. Com A1 dá para calcular pela fila real da cozinha (mediana histórica por produto × itens pendentes). | M | Alto |
| E5 | **Push de etapa pro cliente via WhatsApp.** A máquina `CustomerStage` (`backend/src/domain/customer-order-state.ts`) e o `whatsapp_state` já existem e são ricos, mas nada é enviado automaticamente ao cliente. Cobrindo received→preparing→ready→out_for_delivery→delivered, o cliente para de ligar perguntando. | S | Altíssimo |
| E6 | **Promoções/cupons.** Não existe entidade nenhuma. `freeDeliveryMin` é estático. Marketplace vive de cupom. | M | Médio |
| E7 | **Avaliação pós-entrega.** Canaliza decisão de ranqueamento no marketplace. Hoje zero dado. | M | Médio |

## Camada F — Painéis, relatórios, BI

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| F1 | **Command Center em tempo real** (novo; o `OverviewTab` atual é histórico). KPIs ao vivo via room `dashboard`: vendas hoje vs meta, comandas abertas, ticket médio, tempo médio de preparo, tempo médio mesa→conta, receita por canal, % entrega no prazo, fila do KDS, expected do caixa. Agregação incremental, não re-query por tick. | G | Altíssimo |
| F2 | **Relatórios que faltam**: por canal (com taxa e líquido), por garçom, curva hora × dia da semana, SLA de preparo (% pronto em < X min — dados existem, nunca lidos), perdas/desperdício, inadimplência, comissão iFood. | G | Alto |
| F3 | **Margem real no relatório de vendas.** Hoje usa `order_item.cost_price`, que é `0` em itens lançados antes da feature de estoque → margem silenciosamente errada. Usar o custo médio móvel que já existe em `docs/08-estoque-profissional.md`. | S | Alto |
| F4 | **Mover os filtros de `/reports/sales` para SQL.** `customerQuery` e `productId` são aplicados em memória depois do `select` completo (`report.usecases.ts:59-76`) — a query carrega o filtro inteiro para descartar. O cache de 300s esconde, mas não resolve. | S | Médio |
| F5 | **Export CSV/XLSX em todos os relatórios** + comparar dois períodos lado a lado (hoje só há presets e 1 delta %). | S | Alto |
| F6 | **"Exceções" — uma lista, não 8 abas.** Itens parados na cozinha > N min, comandas abertas > N min, divergência de caixa, canal desconectado, produto ativo com estoque zerado, item sem dono. Uma tela que resolve o que está errado. | M | Alto |

## Camada G — Offline & unificação web/standalone

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| G1 | **Fila offline de comandas.** Hoje o boot bloqueia sem API (`frontend/src/shared/lib/bootSequence.js`) e mutação offline = erro. Wi-Fi ruim num pub = operação para. Cliente IndexedDB + `clientMutationId` idempotente → replay seguro no reconnect. KDS segue online; garçom e caixa degradam. | G | Alto |
| G2 | **Cache de catálogo versionado.** `GET /catalog/version` → cache de produtos/categorias/`store_settings`. `AddItemScreen` fica instantâneo e funciona offline. | M | Alto |
| G3 | **Telemetria de versão instalada.** O gerente precisa saber se o caixa de cada loja está na versão nova. Sem isso, update é problema em vez de solução. | S | Alto |
| G4 | **Modo kiosk no PDV**: abre direto no caixa, sem login por PIN a cada abertura. Reduz fricção no fluxo mais repetido do dia. | M | Médio |

## Camada H — Processo (o que vira regra do sistema)

| # | Proposta | Esforço | Impacto |
|---|---|---|---|
| H1 | **SLA calibrado por histórico.** `kitchenPrepWarnMin`/`urgentMin` são fixos (padrão 3/6). Com A1 + mediana histórica por produto, o alerta passa a dizer "esse prato costuma sair em 7 min, já vai em 9". | M | Alto |
| H2 | **Alerta de atraso no passe e no app do cliente**, não só na tela da cozinha. Hoje quem vê o vermelho é só quem está na cozinha. | S | Alto |
| H3 | **Checklist de abertura/fechamento com assinatura** e roteiro por tela — o processo dentro do PDV. | S | Médio |

---

## Onde a ordem natural erra

A ordem "natural" de produto seria: telas novas primeiro (dashboard, mapa de
mesas, command center), porque é o que se vê e o que impressiona. **Essa ordem
está errada.** Motivos:

- **O `OverviewTab` é bom e não precisa de mais gráfico agora** — ele consome
  dados que ainda não têm tempo (A1) nem liquidez (D1). Um dashboard bonito
  sobre receita bruta de marketplace é pior que nenhum, porque dá confiança
  falsa: mostra R$ X e o gerente decide que o dia foi bom, quando o líquido foi
  R$ X − comissão.
- **Estorno (A4) e settlement (D1) são o item de maior risco**, não o menor.
  Todo dia sem eles, um pedido iFood de R$ 200 entra como R$ 200 de receita e o
  caixa recebe R$ 160 — e não há como o sistema explicar a divergência. Isso não
  é dívida técnica adiável: é um número errado em tela todo dia.

Regra prática: nenhuma tela nova antes de P0 e P1.

---

## Roadmap sugerido

| Fase | Conteúdo | Por que nesta ordem |
|---|---|---|
| P0 — Correção | Os 8 bugs do Tier 0 (o 7 já teve a documentação corrigida; falta a decisão de produto sobre as rotas) | Barreira de confiabilidade. Nada acima é seguro sem isso. |
| P1 — Fundação | A1 (tempos) + D3 (business_date) + B1 (repetir) + E5 (push de etapa) + D8 (Pix) | Itens pequenos, cada um destrava um painel. Entrega valor antes de qualquer tela nova. |
| P2 — Dinheiro | D1 (settlement) + D2 (DRE) + A4 (estorno) + D4 (contagem por cédula) | O financeiro hoje mente sobre marketplace. Maior risco do projeto. |
| P3 — Operação | C1 (expedidor) + C2 (canal no KDS) + C5 (mapa de mesas) + A2/A3 (dividir/juntar/transferir) | Remove o gargalo físico do garçom. |
| P4 — Escala de canais | E1/E2/E3 (hub, painel de canais, preço/disponibilidade por canal) + E7 (avaliação) | É o que torna "nível Anotaí" sustentável em vez de copy-paste por canal. |
| P5 — Inteligência | F1 (command center) + F2 (relatórios) + F6 (exceções) + G1/G2/G3 (offline/cache/telemetria) | Só faz sentido com P1-P3 no lugar — os dados precisam existir antes. |

## Riscos e o que não fazer

- Nenhuma medição de campo foi feita: tempo de lançamento por comanda, taxa de
  erro de digitação no caixa, % de divergência real. Os impactos ("Altíssimo"/"Alto")
  são **julgamento**, não métrica.
- As estimativas de esforço (S/M/G) são de ordem de grandeza, sem starvation
  planning nem quebra em tarefas.
- Nenhuma verificação de licença/custo de API dos marketplaces além do iFood já
  implementado.
- A2 (checkout parcial) muda a semântica de fechamento e é a proposta de maior
  risco de regressão: toca `computeOrderTotal`, validação de pagamento e
  relatórios ao mesmo tempo.
- O ChannelAdapter (E1) é refatoração estrutural — não entrega valor visível
  sozinho, e o caso tentador é adiá-lo até existir um segundo canal real.
- Offline (G1) é caro e tem risco de conflito (dois dispositivos, mesma
  comanda). Não fazer antes de A3 existir.

## Como executar

Cada item acima é pequeno o suficiente para virar uma *delegated task*
independente: um subagente por item, com escopo de arquivos explícito.

- Backend (`@backend-dev`) — camadas A, D, E e as correções do Tier 0:
  `docs/agent-backend.md`, `docs/agent-frontend-map.md` para o contrato de API.
- Frontend (`@frontend-core`) — camadas B, C e H: `docs/agent-frontend.md`,
  `docs/agent-frontend-map.md`.
- Deploy/telemetria (`@devops-bot`) — G3 e o que depender de update/observabilidade:
  `docs/agent-deploy.md`.

Antes de qualquer item: `docs/agent-testing.md` para saber qual suíte precisa
passar. Todo item que muda schema vira migration numerada nova; todo item que
muda realtime precisa confirmar que o evento chega a um room que o client assina.