# Pedido Self-Service Delivery — Página Externa

Este documento consolida as decisões de arquitetura para o canal de pedido self-service — página externa — exclusivamente delivery, com gerência de entrega compartilhada. Segue a convenção dos demais documentos em `docs/`; `00-overview.md` continua sendo o ponto de entrada geral do sistema.

## Objetivo

Permitir que o cliente final peça sozinho, por uma página web, sem intervenção de garçom, com o pedido caindo automaticamente no mesmo fluxo de cozinha já existente, e com gerência de entrega (endereço, taxa, atribuição de entregador, status) até a confirmação de recebimento.

## Escopo desta fase

**Dentro do escopo:**
- Página externa — cardápio e checkout, navegação livre em página web.
- **O canal é exclusivamente delivery** — não há opção de mesa ou retirada.
- Endereços de entrega como cadastro do cliente (até 3, um principal).
- Taxa de entrega (fixa, configurável pelo gerente).
- Gerência de entrega: atribuição de entregador, status de despacho, confirmação.

**Fora do escopo (decisão consciente, não esquecimento):**
- Integração com iFood (Order API e Catalog API) — fase futura; `orders.externalRef` já reservado para isso.
- Rastreamento de localização em tempo real do entregador (mapa/GPS ao vivo).
- Reagendamento automático de entregas com falha — tratamento manual pelo manager.
- Taxa de entrega por zona/bairro ou por distância — começa fixa; schema já comporta evolução (a taxa é gravada por pedido, não só configurada globalmente).
- Telas do entregador — arquitetura definida (rota separada e minimalista, ver abaixo), mas layout/componentes ainda não especificados.

## Decisões de arquitetura

- **Catálogo não é duplicado.** O canal lê produtos/categorias/variações direto de `product.usecases.ts`, o mesmo módulo que já alimenta o PDV.
- **Checkout roda numa função só, chamada sempre pela página.** `createSelfServiceOrderUsecase()`, que por baixo aciona `openOrderUsecase` + `addItemsUsecase` — as mesmas usecases que o garçom já usa. A lógica de identificar/cadastrar cliente e resolver endereço vive só ali, sem duplicação entre canais.
- **Entrega é um eixo separado do status de item**, e agora compartilhado entre canais. `order_item.status` (`ordered → ready → delivered`) já significa "garçom serviu na mesa" — reaproveitar para "motoboy entregou" geraria ambiguidade. Por isso `delivery` é uma tabela própria, aplicável a qualquer pedido com `channel` de self-service (`web`; o valor `whatsapp` do enum só permanece para leitura de pedidos antigos), sem alterar o fluxo de cozinha existente.
- **Pedidos self-service não têm garçom responsável.** `orders.waiter_id` e `audit_log.user_id` são `NOT NULL` — em vez de afrouxar essa constraint (usada em relatórios e auditoria hoje), um usuário técnico fixo (`role: "system"`, `active: false`, nunca autentica) é referenciado como ator nos pedidos e entradas de auditoria geradas automaticamente pela página.
- **Entregador reaproveita o sistema de usuários** — adiciona-se `courier` ao enum `users.role` (hoje `waiter | kitchen | manager`), herdando autenticação de graça.
- **Endereço e taxa são snapshots**, não referências vivas — mesmo princípio já usado em `order_item.unit_price`: editar o cadastro de endereço ou a configuração de taxa depois não pode alterar pedidos já feitos.
- **Limites de endereço são regra de aplicação, não constraint de banco.** "Máximo 3 por cliente" e "só 1 principal por vez" não são expressáveis como constraint simples em Postgres — ficam na camada de usecase, dentro de transação.
- **Tempo real reaproveita o outbox pattern existente** — toda mudança de status de entrega passa pelo mesmo `outbox_event` → WebSocket já usado para comandas, incluindo o acompanhamento ao vivo na página externa.

## Endereços do cliente

Cadastro próprio, reutilizável entre pedidos (a página faz a busca por telefone):

```
customer_address
  id            text, PK
  customer_id   text, FK -> customers
  label         text, nullable      // "Casa", "Trabalho"
  cep           text, nullable      // 8 dígitos crus, sem máscara (migration 0005)
  street        text                 // rua/avenida
  number        text                 // texto, não integer — aceita "S/N"
  complement    text, nullable       // apto, bloco, etc.
  neighborhood  text
  city          text
  reference     text, nullable       // ponto de referência
  is_default    integer (boolean), default false
  created_at    text
```

Regras (aplicadas em usecase, dentro de transação):
- Máximo 3 endereços por cliente — tentativa de adicionar um 4º é rejeitada.
- No máximo 1 marcado como `is_default` por vez — marcar um novo como padrão desmarca o anterior.
- `cep` é opcional e nullable (migration 0005): quem digita o endereço à mão nunca
  preenche o CEP, e os endereços anteriores à coluna não o têm. Aceita com ou sem
  máscara e grava só os 8 dígitos — a máscara é apresentação da tela. Válido exige
  exatamente 8 dígitos; sem nenhum dígito é tratado como não informado. Não é
  consultado contra serviço externo no backend (a busca por CEP é do frontend).

No checkout, a busca por telefone identifica o cliente e mostra os endereços salvos para escolha, ou permite adicionar um novo (se houver vaga) ou cadastrar do zero se for cliente novo.

Estruturar agora (em vez de texto livre) é o que viabiliza, no futuro, taxa de entrega por bairro/distância sem precisar migrar dado histórico — mas `delivery.address` continua sendo um **texto único formatado**, não os campos estruturados replicados. A entrega só precisa exibir/imprimir o endereço (etiqueta de pedido); os campos estruturados existem para consulta e cálculo futuro, não para duplicar no registro de entrega.

## Taxa de entrega

Precisa existir **antes** da entrega ser criada de fato — o cliente vê o total (itens + taxa) no checkout, e nesse momento ainda não existe linha em `delivery` (ela só nasce quando os itens ficam prontos na cozinha). Por isso a taxa vive em `orders`, não em `delivery`:

```
store_settings.delivery_fee: real, default 0   // MVP: taxa fixa única do estabelecimento
orders.delivery_fee: real, nullable             // snapshot do valor cobrado neste pedido
```

`createSelfServiceOrderUsecase()` grava `orders.delivery_fee` a partir de `store_settings.delivery_fee` no momento da criação do pedido. Taxa por zona ou distância é evolução futura, não MVP.

## Fluxo da página externa

Navegação livre em página única, sem máquina de estados persistida no servidor. O carrinho vive no estado do navegador **e** num rascunho no servidor (ver "Continuação do pedido" abaixo):

1. **Cardápio** — consumo de `GET /public/menu`, navegação livre por categoria/produto/variação. **Nada entra no carrinho em um toque**: o clique em qualquer produto abre a **ficha completa** (o `VariationModal` de `frontend/src/shared/components/VariationModal.jsx`, estendido com `imagePath` + `showQuantity` — foto grande, descrição, variações, quantidade e total no CTA), com ou sem variação. O mesmo componente é o do lançamento do garçom (sem esses props, só as opções). O mesmo produto com escolhas diferentes vira **linhas distintas** no carrinho, e uma linha resgatada do servidor sem opção obrigatória pode ser corrigida antes do checkout (nessa edição a ficha abre sem imagem/quantidade — a quantidade muda na tela do carrinho).
2. **Carrinho** — revisão e ajuste de quantidades/observações, com opção de voltar ao cardápio.
3. **Identificação** — telefone como chave; busca/cadastro de cliente e endereço.
4. **Pagamento** — forma pretendida + total com taxa de entrega visível.
5. **Confirmação e acompanhamento** — pedido criado via `POST /public/orders` (`createSelfServiceOrderUsecase()`); a tela de acompanhamento consome o **stage canônico** (`customerStage`/`timeline` de `GET /public/orders/:id/status`), atualizada por WebSocket público com polling de 4s como fallback — sem refresh manual.
   - **Cancelamento pelo cliente** disponível enquanto o stage for `received`, `preparing`, `ready` ou `failed` (`POST /public/orders/:id/cancel`, telefone confere com o dono). Depois que o entregador sai em rota, a tela oferece contato com o estabelecimento em vez do botão.

### Layout da página (responsivo)

Uma tela só, sem menu lateral e **sem painel de carrinho fixado na lateral**, no
formato de loja do iFood — desenhado primeiro para o celular e escalando para o
desktop. Tema escuro/âmbar, igual ao resto do app.

1. **Topo**: header com o **logo no meio** (grade de 3 colunas) e nome do
   estabelecimento centralizado. some ao rolar.
2. **Barra de busca + categorias**: `sticky top-0`, **escondida no topo** e
   revelada ao rolar (cliente sobe a página → ela desce junto). Se o cardápio não
   tem o que rolar, ela fica sempre visível — busca que só aparece depois de
   rolar seria inacessível num cardápio curto. Busca e pilha de chips vivem na
   mesma barra; a barra é montada só quando `showBar` (rolou, tem busca, ou não
   há rolagem).
3. **Destaques**: primeira seção, **3 colunas** (`xl` 4), card vertical com foto
   quadrada, **preço e título abaixo**. Alimentada por `product.featured`
   (migration 0020) — o produto continua aparecendo na sua categoria, igual ao
   iFood.
4. **Categorias**: uma seção por categoria, **um produto abaixo do outro com a
   imagem à direita** (2 colunas no `lg`, 3 no `xl` — a linha não estica na
   largura). É onde mora o detalhe: descrição, aviso de opções e as linhas já
   escolhidas.

### Ficha completa do produto (nada entra no carrinho em um toque)

**Não existe botão de "+"** nos cards (`ProductTile`/`ProductCard`): o clique no
card abre a **ficha completa do produto** — foto grande, descrição, variações,
**controle de quantidade** e total no botão — antes de qualquer coisa entrar no
carrinho. Vale para produto **sem variação também** (antes ele ia direto). A
ficha é o mesmo `VariationModal` compartilhado com o garçom, estendido com os
props `imagePath` + `showQuantity` (desligados por padrão: o garçom continua
vendo só as opções; a página pública liga os dois). `onConfirm(sel, notes, qty)`
só recebe o 3º argumento quando `showQuantity` está ligado.

O card ainda mostra o que já está no carrinho: badge "N no carrinho" e, nas
categorias, as linhas com variação (que o cliente ajusta por ali, sem reabrir a
ficha — os botões de linha levam produto + variação no `aria-label`).

As pills de categoria **não filtram**: elas rolam até a seção
(`scrollIntoView` + `scroll-mt`, com `id="sec-<id>"`), e a pill da seção visível
fica acesa. Só a busca filtra, e com texto a página vira uma lista plana
"Resultados" (sem pills, porque não há seção para pular). A seção em tela é
calculada no scroll com `getBoundingClientRect` (com `requestAnimationFrame`) em
vez de `IntersectionObserver`, porque a fonte de scroll muda entre celular
(documento) e desktop (a coluna esquerda) e o cálculo serve para os dois.

### Carrinho

O painel "Seu pedido" fixado à direita do desktop **foi removido** — a página é
coluna única em todas as larguras. O carrinho é aberto pela **barra flutuante**
`fixed`: barra full-width no rodapé do celular, cartão no canto inferior direito
(`lg:right-8 lg:w-80`) no desktop. Ela abre a tela cheia de carrinho ("Seu
carrinho"), que segue para o checkout.

A lógica de linha (chave, agrupamento por produto, grupos obrigatórios) fica
pura em `frontend/src/features/customer-menu/cartLogic.js`, testada sem DOM. Os
cards (`ProductTile`, `ProductCard`) são apresentação fina sobre ela.

### Continuação do pedido (carrinho server-side)

O estado do navegador morre com a aba — fechar/recarregar no meio do checkout
perdia o pedido em andamento. Duas superfícies resolvem, sem `localStorage`
(fonte da verdade no servidor, como o resto do sistema):

1. **Rascunho do carrinho** (`GET/PUT/DELETE /public/cart`) — chaveado por
   telefone, TTL de 24h, guardado em `customer_cart`. A página grava com debounce
   (~800ms) a cada mudança de linha e força o flush ao entrar no checkout, e
   hidrata de volta ao abrir (item que saiu do menu é descartado). Só os itens
   são persistidos: endereço e pagamento são re-derivados. Web direta sem
   telefone tem o carrinho só em memória — perda aceita, já que pedir telefone
   antes do checkout custaria mais caro do que o problema que resolve.
   O rascunho é apagado quando o pedido é criado.
2. **Pedido em andamento** (`POST /public/orders/active`, por telefone) — vira
   o banner "Você tem um pedido em andamento" no cardápio, e a página aceita o
   parâmetro `?order=<orderId>` direto pra abrir o acompanhamento (o `orderId` é
   a "senha" de fato, como já era no `GET .../status`).

O acompanhamento por WebSocket é o mesmo endpoint público `/realtime/public`,
que aceita **só** a sala `order:<orderId>`; qualquer outra sala (ou pedido
inexistente) recebe `join.denied`.

## Fluxo de gerência de entrega

Estados em `delivery.status`, aplicável a qualquer pedido com `orders.channel` de self-service (`web`; o valor `whatsapp` do enum só permanece para leitura de pedidos antigos):

1. **`awaiting_courier`** — criado no mesmo momento do pedido, dentro de `createSelfServiceOrderUsecase()`, já com o endereço escolhido no checkout. Não se espera a cozinha: o endereço já está resolvido nesse ponto, e o manager pode planejar/atribuir entregador com antecedência, antes mesmo de os itens saírem para preparo. (Revisão em relação ao desenho original desta fase, que previa criar a linha só quando os itens ficassem prontos — decisão descartada na implementação porque adiar exigiria guardar o endereço em algum lugar intermediário até lá, sem ganho real.)
2. **Itens prontos na cozinha**, em paralelo — `order_items` em `ready`. Fluxo de cozinha inalterado; não é um estado de `delivery`, é só o momento em que a comida fica pronta para o entregador levar.
3. **`out_for_delivery`** — manager atribui `courier_id` (`assign`, sem mudar o status); entregador confirma saída (`dispatch`, `dispatched_at`).
4. **`delivered`** — entregador confirma entrega (`delivered_at`).
   - Desvio possível: **`failed`**, a partir de `out_for_delivery`, com `notes` registrando o motivo — tratamento manual pelo manager. O pedido continua aberto: o cliente pode cancelar (evitando cobrança) ou o manager reordena.
5. **`cancelled`** — desvio de `awaiting_courier`, `out_for_delivery` (cancelamento de comanda pelo manager) ou `failed` (cliente ou manager cancelou o pedido aberto). É aplicado **na mesma transação** do cancelamento da comanda, junto do cancelamento do iFood (`status-pushback.ts`, que antes marcava `failed` e agora marca `cancelled` — o iFood ser a fonte da verdade é cancelamento, não falha de entrega). Terminal.

As transições válidas são uma matriz única (`DELIVERY_TRANSITIONS` em
`domain/customer-order-state.ts`) consumida por dispatch/deliver/fail,
cancelamento de comanda e pushback do iFood — quem chama decide o `status`
novo, a máquina diz se pode.

`orders.status` (`open`/`closed`) continua controlando o encerramento financeiro — fecha quando o pagamento é confirmado, com o gatilho passando a ser a confirmação do entregador em vez do garçom fechando a comanda.

## Mudanças de schema

**Em tabelas existentes:**

```
users.role: "waiter" | "kitchen" | "manager" | "courier" | "system"   // + courier, + system

orders.channel: "balcao" | "whatsapp" | "web"    // novo, default "balcao" — "whatsapp" só permanece para leitura de pedidos antigos
orders.externalRef: text, nullable                // reservado para integração futura com iFood
orders.delivery_fee: real, nullable               // snapshot da taxa cobrada

store_settings.delivery_fee: real, default 0      // configuração da taxa fixa
```

Uma linha seedada na migration: usuário `system` (`role: "system"`, `active: false`), referenciado como `waiter_id`/`user_id` em pedidos e auditoria de origem self-service — nunca autentica, existe só para satisfazer as constraints `NOT NULL` que já existiam.

**Tabelas novas:**

```
customer_address
  id            text, PK
  customer_id   text, FK -> customers
  label         text, nullable
  street        text
  number        text
  complement    text, nullable
  neighborhood  text
  city          text
  reference     text, nullable
  is_default    integer (boolean), default false
  created_at    text

delivery
  id                text, PK
  order_id          text, FK -> orders, único (1:1)
  courier_id        text, FK -> users, nullable
  address           text          // snapshot, copiado do checkout
  status            enum: "awaiting_courier" | "out_for_delivery" | "delivered" | "failed" | "cancelled"
  dispatched_at     text, nullable
  delivered_at      text, nullable
  notes             text, nullable

customer_cart
  phone       text, PK        // identidade do rascunho = telefone do checkout
  items       text (JSON)     // [{ productId, quantity, selectedVariations, notes }]
  updated_at  text
  expires_at  text            // TTL 24h, expurgado pelo job de manutenção
```

`"cancelled"` em `delivery.status` entrou em migration à parte
(`0018_delivery_cancelled.sql` — recria a tabela, porque migração não altera
enum), junto do `customer_cart` (`0019_customer_cart.sql`).

## Superfícies de UI

Nem toda interação nova exige uma tela nova. Distinção importante:

| Superfície | Tela nova? | Onde vive |
|---|---|---|
| Cliente pela página externa | **Sim, isolada** | Pública, sem login, layout próprio |
| Entregador | **Sim, isolada** | Autenticada, dentro do mesmo frontend do PDV, casca própria (sem as telas do gerente) — o menu do app entra só como **trilho de ícones** de 4rem com "Entregas", para não gastar 288px de largura com um item único |
| Manager atribuindo entregador | Sim, mas **dentro do app existente** | Rota/aba nova no manager-app já existente |
| Manager configurando taxa de entrega | Não — campo a mais | Tela de configurações já existente |

Mockups das três telas novas (página do cliente, entregador, painel do manager) foram desenhados e validados. Decisões de UX que vieram deles: carrinho fixo no rodapé da página do cliente; card do entregador com no máximo 2 ações visíveis por entrega; e no painel do manager, a coluna de ação fica somente leitura entre a atribuição do entregador e a confirmação de saída dele — reforçando a separação entre `assign` e `dispatch` já formalizada em `05-delivery-api-contracts.md`.

## Novos módulos e endpoints

**Implementado (checkout, entrega, cardápio):**

```
backend/src/application/self-service/
  menu.usecases.ts               # cardápio público, lê direto de product/category existentes
  customer-address.usecases.ts   # busca/cadastro de cliente e endereço, limite de 3
  order-intake.usecase.ts        # createSelfServiceOrder() — ponto único de checkout,
                                 # getSelfServiceOrderStatus(), getActiveSelfServiceOrderByPhone()
  delivery.usecases.ts           # assign, dispatch, deliver, fail — gerência de entrega
  customer-stage.ts              # deriva o stage canônico e emite customer.stage_changed
  cart.usecases.ts               # rascunho do carrinho por telefone (TTL 24h)
  cancel-order.usecase.ts        # cancelamento pelo cliente (dono + stage cancelável)

backend/src/domain/
  customer-order-state.ts        # stages, labels, timeline, transições de delivery

backend/src/http/routes/
  public.routes.ts               # GET /public/menu, POST /public/customers[/lookup|/:id/addresses],
                                 # POST /public/orders, POST /public/orders/active,
                                 # POST /public/orders/:id/cancel, GET|PUT|DELETE /public/cart
  courier.routes.ts              # GET /courier/deliveries, PATCH .../dispatch|deliver|fail
  delivery-manager.routes.ts     # GET /manager/deliveries|couriers, PATCH .../assign
  realtime.routes.ts             # + /realtime/public (sala única order:<orderId>, sem JWT)

backend/src/domain/constants.ts  # SYSTEM_USER_ID — ator técnico para pedidos self-service
```

`order.usecases.ts#openOrderUsecase` foi estendido (não duplicado) para aceitar `channel`/`deliveryFee` opcionais — o self-service reaproveita a mesma função que o garçom usa, como planejado.

Interface de entregador: rota nova dentro do mesmo frontend, com casca própria (sem as telas do gerente) — não um app separado, não uma view restrita do painel do lojista. Login reaproveita `users`/`role: courier`. O menu principal do app é compartilhado por todos os papéis logados (`widgets/app-menu`); para um perfil de tela única ele degenera em **trilho de ícones** de 4rem — o entregador vê só o próprio ícone de "Entregas". O "Sair" é um botão circular no canto direito do header, então o painel inteiro do celular não o repete (o scrim cobre o header; ele fica no rodapé do painel só a identidade de quem está logado).

## Decisões pendentes

- **Contratos de API**: especificados em `05-delivery-api-contracts.md`, implementados.
- **Usecases e rotas** (checkout, entrega, cardápio público): implementados e testados — ver seção "Novos módulos e endpoints".
- **Protótipos**: os três (página, entregador, painel do manager) desenhados, navegáveis e testados manualmente.
- **Taxa por zona/distância**: fora do MVP; schema já comporta porque a taxa é gravada por pedido e os endereços já são estruturados.
- **Migrations Drizzle**: geradas em `migrations/0002_delivery_self_service.sql` e `src/infra/db/schema.ts`, testadas contra a `0001_init.sql`.
- **Telas do entregador, da página externa e do painel do manager**: mockups desenhados e validados; implementação de frontend ainda não iniciada.
- **Máquina de estado do cliente**: implementada — stage canônico derivado dos 3 eixos internos, timeline, matriz de transições de delivery, evento `customer.stage_changed` e cancelamento pelo cliente (detalhes em `05-delivery-api-contracts.md`).
- **Continuação do pedido**: implementada sem `localStorage` — rascunho do carrinho no servidor (`customer_cart`, TTL 24h) + banner de pedido em andamento por telefone + retomada por `?order=<orderId>`; WebSocket público com polling de 4s como fallback. Etapa e endereço do checkout são re-derivados, não persistidos.
