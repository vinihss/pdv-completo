# Visão Geral — Sistema de PDV (Restaurante/Pub)

Este documento resume as decisões-chave já tomadas, servindo de ponto de entrada para os dois documentos detalhados (`01-backend-spec.md`, `02-frontend-spec.md`) e os protótipos navegáveis. Se algo aqui divergir de um dos documentos detalhados, o documento detalhado é a fonte da verdade — este arquivo existe pra dar contexto rápido, não pra substituir a spec.

## O que é

PDV para restaurante/pub, cobrindo o ciclo: abrir comanda → lançar itens → (opcionalmente) cozinha prepara → garçom entrega → fechar conta. Etapa 1 é deliberadamente enxuta: sem ficha técnica, sem processamento automático de pagamento, sem emissão fiscal, sem roteamento automático de pedido para estações. Controle de estoque **simples** (saldo por produto com `track_stock`, débito automático no lançamento, entrada/ajuste manual e alerta de estoque baixo) existe e é opcional por configuração — ver `07-estoque.md`.

O mesmo produto atende perfis de estabelecimento bem diferentes através de configuração, não de código separado:
- **Restaurante tradicional**: organiza o salão por mesa numerada, tem cozinha separada preparando os pedidos.
- **Pub sem mesas e sem cozinha**: comandas vinculadas a cliente cadastrado ou a um rótulo livre (ex: "Comanda 12"); quem serve também prepara, então o item vai direto de lançado pra entregue.

Essa flexibilidade vem de dois toggles em `store_settings`: `uses_tables` e `kitchen_enabled` — ver seção "Decisões de dados" abaixo.

## Modelo de implantação

Um único código-fonte, dois modos de deploy, diferenciados só por variável de ambiente (`DEPLOYMENT_MODE`, `DATABASE_URL`):

| Modo | Onde roda | Depende de internet? |
|---|---|---|
| **local** | servidor físico (mini-PC/NUC) no estabelecimento, via Docker | Não — Wi-Fi interno |
| **cloud** | banco gerenciado (RDS/Supabase) | Sim — não é offline-first |

Stack: Node.js + TypeScript, Fastify, Drizzle ORM (SQL-first sobre PostgreSQL), WebSocket para tempo real, Zod para validação, JWT + PIN numérico (argon2) para autenticação rápida em terminal compartilhado. O Postgres é o único banco suportado — o SQLite foi removido; `DEPLOYMENT_MODE` decide se o Postgres é o do compose local ou uma instância gerenciada.

### Como o PDV chega à loja

O mesmo frontend é servido de três formas, sem código duplicado:

| Forma | Onde | Quem usa |
|---|---|---|
| **App Windows** (Tauri) | terminal da loja, instalado | garçom, cozinha, gerente, caixa, entregador |
| **PWA no navegador** | servido pelo Caddy | computador de passagem, treino, contingência |
| **Painel web** | qualquer navegador | gerente e cliente |

O app Windows é um instalador único que também instala o daemon de impressão
como serviço do Windows (a cozinha imprime com o app fechado). A loja é
configurada por arquivo (`%ProgramData%\PDV\app.json`: `mode` local ou cloud,
`apiBase`, `daemonUrl`) — não por um instalador diferente por loja. O app
verifica atualização e conectividade antes de abrir, e uma falha de update
nunca bloqueia: numa loja sem internet o PDV abre na versão em disco. Ver
`11-desktop-instalador.md`.

## Perfis de usuário e telas

| Perfil | Função | Tela / protótipo |
|---|---|---|
| **waiter** (garçom) | Abre comanda, lança itens, entrega, fecha conta | `waiter-app-prototype.jsx` |
| **kitchen** (cozinha) | Vê pedidos, marca como pronto — opcional, ver `kitchen_enabled` | `kitchen-display-prototype.jsx` |
| **manager** (gerente) | Mesmo acesso a comandas que o garçom (não só caixa), + cadastros, configuração e relatórios | `manager-app-prototype.jsx` |
| **cashier** (caixa) | Opera o fluxo de caixa (sessão única: abertura, sangria/suprimento, fechamento e impressão de recibo) | Cashdrawer da tela de login |
| **courier** (entregador) | Recebe as entregas atribuídas a ele, confirma saída e entrega — opcional, ver `uses_delivery` | Entregas da tela de login |

`pos-app-integrated.jsx` reúne os três perfis principais num único fluxo com login e sessão compartilhada — os protótipos standalone acima têm as mesmas funcionalidades, mas cada um roda isolado (sem login, sem trocar de perfil). Caixa e entregador são perfis mais recentes, restritos por papel no backend: `cashier` e `manager` operam o fluxo de caixa, `courier` e `manager` enxergam/atribuem entregas (o manager vê todas; o courier só as atribuídas a ele). O login também respeita os toggles de rollout — com `uses_delivery` desligado, usuários `courier` somem da lista de seleção (paridade com `kitchen_enabled`, que some com a cozinha).

## Decisões de dados (schema)

- **Identificação da comanda é flexível, não hierárquica**: `table_id`, `customer_id` e `tab_label` são independentes; a constraint `order_identification_required` exige só que ao menos um esteja preenchido. É isso que permite o mesmo schema atender restaurante (mesa) e pub (cliente ou rótulo livre).
- **`unit_price` em `order_item` é snapshot**, não referência viva a `product.price` — alterar o preço do produto não muda comandas já lançadas.
- **`variations`/`selected_variations` em JSONB**, não normalizado — decisão consciente de simplicidade para a etapa 1; migrar para tabela própria só se etapa 2 exigir queries por variação específica.
- **Lock otimista por item** (campo `version` em `order_item`), não por comanda inteira — dois garçons podem mexer em itens diferentes da mesma comanda sem conflito.
- **`audit_log`** registra toda ação relevante (abertura/fechamento de comanda, item adicionado/removido/entregue) de forma assíncrona, consultável por comanda.
- **Estoque é obtido por ledger**, não por coluna denormalizada: `stock_movement` guarda cada venda/estorno/compra/ajuste e o saldo é a soma dos deltas — histórico auditável e sem risco de divergência com a "contagem real". Dados pela flag `store_settings.inventory_enabled` + `product.track_stock`, padrões desligados (rollout seguro).
- **Idempotência** via `correlationId` gerado no client, obrigatória em `POST /orders`, `POST /orders/:id/items` e `PATCH /orders/:id/close`.
- **Outbox pattern** para eventos WebSocket — garante entrega mesmo se o processo cair entre o commit no banco e o broadcast.

## Decisões de configuração (gerente)

Tabela `store_settings` concentra os parâmetros que mudam o comportamento do app sem precisar de deploy. Nasceu como singleton (uma linha só), mas desde a migration `0011_store_settings_per_store.sql` é **uma linha por store** (`UNIQUE` em `store_id`): o tenant vem do middleware de subdomínio (`req.storeId`) e cada loja tem suas próprias flags:

| Campo | Efeito |
|---|---|
| `uses_tables` | `false` remove a opção "Mesa" na abertura de comanda do garçom (fluxo tipo pub) |
| `kitchen_enabled` | `false` remove a etapa `ready` do fluxo de item (`ordered` → `delivered` direto) e some com o usuário `kitchen` do login |
| `uses_delivery` | `false` desliga a página/comanda pública de delivery e some com os usuários `courier` do login |
| `enabled_payment_methods` | controla quais formas de pagamento aparecem no fechamento de conta |
| `pix_key`, `merchant_name`, `merchant_city` | necessários para gerar o QR Pix (BR Code); sem isso, botão de Pix fica desabilitado |
| `kitchen_prep_warn_min`, `kitchen_prep_urgent_min`, `kitchen_pickup_urgent_min` | limiares de tempo (minutos) que definem quando um cartão vira âmbar/vermelho na tela da cozinha; só relevantes se `kitchen_enabled = true` |
| `inventory_enabled` | `false` remove a validação de estoque no lançamento e a aba Estoque do gerente; `true` liga o módulo (débito/bloqueio em produtos com `track_stock` + movimentos manuais) — ver `07-estoque.md` |

## Decisões de UX chave (garçom)

- **Adicionar item é carrinho → revisão → confirmação em lote**, não commit a cada toque — testou mal quando era imediato, o garçom perdia a noção do que já tinha lançado. Ao confirmar, tela de sucesso breve e volta direto pra lista de comandas (o garçom normalmente vai atender outra mesa em seguida).
- **Remover item só é permitido se ainda não `delivered`**, sempre com confirmação explícita (nunca ação de um toque só).
- **Fechar conta exige confirmação em toda forma de pagamento**, não só no Pix — nenhuma forma fecha a comanda no primeiro toque.
- **Pix é geração local de QR (BR Code)**, sem integração com PSP/banco — a confirmação de recebimento é sempre manual, depois de conferir o extrato.

## Decisões de UX chave (cozinha)

- Duas zonas: **Em preparo** (toque no cartão inteiro marca como pronto) e **Prontos** (aguardando retirada pelo garçom).
- Cronômetro por item com escalada de cor (neutro → âmbar em 3min → vermelho pulsante em 6min, em preparo; vermelho pulsante em 5min parado em "Prontos") — sinaliza prioridade sem exigir reordenação manual.
- Um item só sai da zona "Prontos" quando o garçom marca `delivered` no app dele — nunca por tempo, sempre por ação real.

## Decisões de UX chave (gerente)

- Categorias com CRUD completo: criar, renomear inline, reordenar (setas), excluir (com aviso se houver produtos vinculados — exclusão não é bloqueada, só avisada, e produtos ficam sem categoria até reatribuição).
- **Gerente tem acesso total às comandas, não só função de caixa**: abre, lança item, remove item, marca entregue, fecha — a mesma interface do garçom, sobre o mesmo estado. Substituiu a versão anterior (só ver/fechar), que era limitada demais na prática.
- **Cozinha é opcional, configurável pelo gerente** (`kitchen_enabled`): estabelecimentos sem estação de preparo separada (ex: pub pequeno) desligam o recurso — o item pula `ready` e vai direto de `ordered` pra `delivered`, o usuário `kitchen` some do login, e os limiares de tempo da cozinha somem das Configurações.
- **Relatório de vendas**: filtro por período, cliente/mesa e produto; resumo de total vendido, ticket médio e detalhamento por forma de pagamento — sempre sobre comandas fechadas, calculado a partir do `unit_price` gravado no lançamento (nunca o preço atual do produto). Com estoque ligado, ganha **margem por produto** (receita vs. custo, ambos snapshots do lançamento).
- **Controle de estoque (gerente)**: aba "Estoque" (visível só com `store_settings.inventory_enabled`) com saldo vivo por produto, alerta de estoque baixo, entrada de mercadoria (compra) e ajuste de contagem (positivo/negativo). Produtos com `track_stock` desabilitam na tela de lançamento quando o saldo zera. Ver `07-estoque.md`.

## Fechar comanda com item pendente — resolvido

A comanda só pode ser fechada quando todo item estiver `delivered`. Essa regra já existia no backend (`closeOrder` bloqueia via transação, lançando `PendingItemsError`) mas não estava refletida na UI. Agora:

- **Garçom**: botão "Fechar conta" fica desabilitado com aviso listando os itens pendentes por nome, em vez de deixar o garçom tentar fechar e receber erro.
- **Gerente**: em `pos-app-integrated.jsx`, o gerente vê exatamente o mesmo aviso, já que a tela de Comandas é a mesma interface do garçom (ver "Decisões de UX chave (gerente)" acima). Em `manager-app-prototype.jsx` (versão standalone, mais antiga), o comportamento é diferente: a lista de comandas abertas mostra o primeiro item pendente + tooltip com a lista completa no lugar do botão "Fechar" — funcional, mas não é mais a versão de referência.

## Pontos de produto — todos resolvidos

- **Limites de tempo do destaque visual na cozinha**: configuráveis pelo gerente (`store_settings.kitchen_prep_warn_min`/`kitchen_prep_urgent_min`/`kitchen_pickup_urgent_min`), padrão 3/6/5 minutos — não são mais constantes fixas no código.
- **Telefone no cadastro rápido de cliente**: opcional, confirmado.

## Arquivos do projeto

| Arquivo | Conteúdo |
|---|---|
| `00-overview.md` | este documento |
| `01-backend-spec.md` | schema SQL, arquitetura em camadas, API REST, WebSocket, concorrência, idempotência, Pix, auditoria, setup (env/seed/health/migrations), requisitos não-funcionais, deployment |
| `02-frontend-spec.md` | fluxos de garçom, cozinha e gerente, tela por tela |
| `03-acceptance-criteria.md` | critérios de aceite em formato Dado/Quando/Então, por funcionalidade, com destaque pros pontos que já geraram ambiguidade no projeto |
| `04-cash-flow.md` | spec do fluxo de caixa (sessão única, hard block de dinheiro, estorno automático, fechamento/impressão, resumo por período) |
| `07-estoque.md` | spec do controle de estoque (ledger `stock_movement`, flags de rollout, endpoints, regras de corretude e testes) |
| `login-prototype.jsx` | protótipo navegável só do login (seleção de usuário + PIN) |
| `waiter-app-prototype.jsx` | protótipo navegável do garçom, standalone |
| `manager-app-prototype.jsx` | protótipo navegável do gerente, standalone — mesmo acesso a comandas que o garçom (não só caixa), toggle de cozinha e Relatórios |
| `kitchen-display-prototype.jsx` | protótipo navegável da cozinha, standalone |
| `pos-app-integrated.jsx` | login + garçom + gerente + cozinha num único fluxo, com sessão compartilhada — mesmas funcionalidades dos protótipos standalone, mas com troca de perfil pelo login |

## Fluxo de caixa

O caixa é uma **sessão única por vez** (fundo inicial + vendas em dinheiro
confirmadas no período + suprimentos − sangrias). Papéis `cashier` e
`manager` operam a gaveta; a confirmação de pagamento em dinheiro exige caixa
aberto (bloqueio na transação) e o cancelamento de comanda paga em dinheiro
gera sangria automática com `ref_order_id`. Detalhes, endpoint por endpoint,
em `04-cash-flow.md`; critérios de aceite na §14 de `03-acceptance-criteria.md`.

## O que ainda não existe

- Endpoints reais implementados — hoje a spec descreve a API, mas os protótipos usam dados mock em memória (React state), sem chamadas HTTP/WebSocket reais.
- Tela de histórico de cliente (consumo anterior) — schema já tem a entidade `customer` pronta para isso, mas está fora do escopo da etapa 1.
- A seção 7 do `01-backend-spec.md` foi detalhada com request/response, status HTTP e formato de erro por endpoint (antes só listava rotas). Duas descobertas dessa revisão: `PATCH /orders/:id/payment` e `GET/PUT /store-settings` existiam na seção de Pix mas não estavam na lista consolidada de endpoints (corrigido); e `closeOrder` ganhou uma validação nova (`payment_not_registered`) que ainda não existia no pseudocódigo original. O erro 409 de fechamento com item pendente devolve a lista de itens, não só a contagem — refletido em todos os protótipos: o botão "Fechar conta" lista os itens pendentes por nome, tanto pro garçom quanto pro gerente, já que agora usam a mesma tela em todos os arquivos (a antiga tela de caixa separada, com resumo por tooltip, foi descontinuada em todo lugar, não só no integrado).
- `GET /reports/sales` está especificado (seção 7.9 do backend spec) mas só existe como filtro client-side sobre o mock em memória no protótipo — sem agregação real de banco.
- **Divergência entre protótipos**: as três mudanças mais recentes (gerente com acesso total às comandas, cozinha condicional, relatório de vendas) foram implementadas só no `pos-app-integrated.jsx`. Os protótipos standalone `waiter-app-prototype.jsx` e `manager-app-prototype.jsx` ainda refletem a versão anterior (gerente só com função de caixa, sem toggle de cozinha, sem relatório) — não foram atualizados porque o valor de mantê-los sincronizados é baixo a essa altura (o arquivo integrado é a referência mais completa). Se algum dia forem reutilizados isoladamente, precisam desse retrofit.
- O `.env.example` em si (arquivo, não só a tabela de variáveis na spec) e o script de seed (`npm run seed`) ainda precisam ser escritos como código — a seção 14 do backend spec agora especifica o que eles devem conter, mas não são arquivos reais ainda.

## Revisão de prontidão pra implementação (última passada)

- **Inconsistência corrigida**: a seção 14 do backend spec desenhava um `docker-compose.yml` com container `db` em Postgres também no modo local, contradizendo a seção 3 (que definia SQLite pro modo local desde o início). **Resolvido em 2026 removendo o SQLite**: o modo local também usa Postgres, então a contradição deixou de existir (compose local sobe `postgres` + `backend` + `frontend`).
- **Seção 14 expandida** de "Deployment" pra "Deployment e Setup": tabela de variáveis de ambiente completa, estratégia de seed (dev vs. primeiro deploy real), endpoint `GET /health`, e estratégia de migrations (Drizzle Kit, quando roda automático vs. manual).
- **Nova seção 15** no backend spec: requisitos não-funcionais — volume esperado, latência aceitável, segurança por modo de implantação, e a lacuna de backup em modo local sem `SYNC_ENABLED` (que precisa ficar explícita pro dono do estabelecimento, não é implícita).
- **Checagem de consistência**: toda referência cruzada entre `01-backend-spec.md` e `02-frontend-spec.md` (números de seção) e todo código de erro da tabela consolidada (seção 7.11) foram conferidos contra o restante do texto — sem divergência encontrada além da do docker-compose acima.
