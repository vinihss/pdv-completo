# Plano de implementação — Cobranças do Caixa

**Projeto:** `vinihss/pdv-completo`  
**Fase:** primeira entrega, checkout simples do Caixa  
**Status:** especificação para implementação; nenhum dos itens abaixo é marcado como concluído  
**Data:** 9 de outubro de 2026

## 1. Objetivo

Entregar ao perfil Caixa uma tela própria para localizar comandas locais prontas para cobrança, conferir a conta, registrar o pagamento já suportado pelo PDV e fechar a comanda segundo as regras atuais. A tela deve ser separada do OrderBoard do garçom e do controle da gaveta, funcionar em celular e desktop e minimizar os dados pessoais retornados.

**Regra da fase:** reutilizar o ledger e os casos de uso atuais; não introduzir novo modelo de rateio.

## 2. Decisões fechadas para esta fase

| Tema | Decisão da primeira entrega |
|---|---|
| Papel | Menu visível ao Caixa. Rotas autorizam `cashier` e `manager`; waiter, kitchen e courier não recebem acesso à nova tela/rotas de cobrança. |
| Comandas da fila | Somente pedidos locais (`channel = balcao`) ainda abertos; pedidos web/WhatsApp/iFood/delivery seguem os fluxos próprios existentes. |
| Aptidão para concluir | Só permitir fechamento quando todos os itens não cancelados estiverem `delivered`; itens `cancelled` não contam como pendência, conforme `closeOrderUsecase` atual. Contas com itens pendentes podem aparecer em grupo secundário bloqueado, sem CTA de recebimento/fechamento. |
| Pagamento | Reusar `PaymentModal`, `setPayments`, `confirmPayment` e `closeOrder`. Os pagamentos submetidos continuam cobrindo o total completo no lote; cada forma tem seu estado existente. |
| Dinheiro | Dinheiro confirmado continua exigindo gaveta aberta. Se a gaveta estiver fechada, informar o motivo e bloquear somente dinheiro na interface; o backend continua sendo autoridade final. |
| Pix | Manter o fluxo local de QR/confirmação manual já usado por `PaymentModal`. Não adicionar fluxo novo de adquirente/gateway nesta fase. |
| Rateio | **Fora de escopo:** nenhuma tabela `order_split`, participante, alocação/tender, migration, pagamento incremental por pessoa, cobrança independente de parcela ou atribuição por item. O helper de divisão igual que já existe no `PaymentModal` pode permanecer sem expansão — atualmente gera N linhas de igual valor usando um único método. Não adicionar nomes de pagadores nem métodos independentes por pessoa. |
| Gaveta | `CashDrawerTab` continua responsável pela sessão, fundo, sangria/suprimento, fechamento e histórico. Cobranças é uma tela irmã. |
| Realtime | Atualizar a fila via room seguro `cashier:collections`; os eventos levam apenas o ID da comanda/tipo de mudança e disparam refetch autorizado. Não dar ao Caixa acesso a `kitchen-display`. |
| Persistência | **Nenhuma mudança em `schema.ts` ou migration de dados** nesta fase. Usar `order`, `order_item`, `order_payment`, `restaurant_table` e `user` atuais. |

## 3. Jornada visual/operacional

1. Caixa abre **Cobranças** no menu; vê o total de contas prontas e a busca.
2. Localiza a conta por mesa, rótulo/código ou nome necessário à identificação. A fila é ordenada pela mais antiga primeiro.
3. Abre o checkout focalizado, confere mesa/comanda, total e resumo dos itens/pagamentos existentes.
4. Escolhe um ou mais métodos atualmente habilitados. O total das linhas precisa continuar fechando exatamente o total da comanda.
5. Se houver dinheiro, informa recebido/troco e a gaveta precisa estar aberta. Pix permanece pendente até a confirmação manual do fluxo atual.
6. Após todos os pagamentos confirmados, a tela tenta fechar a comanda pela operação existente. Sucesso remove a conta da fila e mostra resumo/troco; erro mantém contexto e explica bloqueio.
7. Se itens ainda estiverem pendentes, exibir “Aguardando entrega de X itens”; o Caixa não altera estado da cozinha. A conta não fecha nem libera mesa.
8. Se o caixa físico estiver fechado, cartão/Pix seguem disponíveis se habilitados; dinheiro fica indisponível e a tela oferece orientação para abrir a gaveta.

**Mobile:** lista em cartões de uma coluna; ao cobrar, checkout ocupa a tela toda; voltar preserva filtro/rolagem. **Desktop:** lista e detalhe lado a lado apenas quando houver largura; não comprimir a área dos métodos de pagamento.

## 4. Contrato HTTP a implementar

### `GET /cashier/collections`

Autenticação normal + `requireRole("cashier", "manager")` + `ensureTenantScope`.

Query proposta: `q` (opcional), `state=ready|blocked|all` (padrão `ready`), `limit` com máximo 100 e `offset` não negativo.

Resposta paginada `{ data, total }`; cada cartão inclui apenas:

- `id`, `tableId`, `tableNumber`, `tabLabel`, `customerName` (se necessário à identificação), `waiterName`;
- `openedAt`, `itemCount`, `total`, `paymentState` (`unpaid|pending_confirmation|paid`), `confirmedAmount`;
- `pendingItemCount`, `canCharge`, `canClose` e motivo curto de bloqueio.

Critérios da consulta: `status=open`, `channel=balcao`, tem itens ativos. `ready` exige ao menos um item não cancelado e todos esses itens `delivered`; `blocked` inclui ao menos um item não cancelado ainda não entregue; pedidos sem itens cobráveis (todos cancelados/vazios) não entram na fila; pedidos com total pago mas ainda abertos permanecem visíveis para terminar o fechamento. Filtrar/contar/paginar no servidor e ordenar pelo mais antigo. Busca parametrizada, sem baixar todas as comandas para filtrar no browser.

**Não retornar** telefone, endereço de entrega, notas privadas, custo/margem, dados de gateway, imagens ou arrays completos de modificadores na listagem.

### `GET /cashier/collections/:orderId`

Autorização igual à lista; validar existência, tenant, `status=open` e `channel=balcao`. Retornar DTO mínimo do checkout: identificação de mesa/rótulo, nome estritamente necessário, `openedAt`, `deliveryFee` quando aplicável, `items` com `id/name/quantity/unitPrice/selectedVariations/status/version`, `payments` no formato atual, total e lista dos bloqueios.

`unitPrice`, `quantity`, `status` dos itens e `deliveryFee` devem ser suficientes para `orderTotal`/`PaymentModal`; usar snapshot da comanda, nunca preço atual do produto. Não reutilizar sem revisão `serializeOrder`, que devolve detalhes não necessários para esta tela.

### Escrita

Não criar API de split nem aceitar `amount < total` como quitação da conta. Reutilizar os paths atuais e ampliar somente a autorização necessária:

- `PUT /orders/:id/payments`: permitir `cashier, manager` para registrar o conjunto de linhas completo.
- `PATCH /orders/:id/payments/:paymentId`: permitir `cashier, manager` para a confirmação manual Pix já existente.
- `PATCH /orders/:id/close`: permitir `cashier, manager`; continuar passando por `closeOrderUsecase`, com itens prontos, pagamentos existentes/confirmados e total exato.

Manter `DELETE /orders/:id/payments/:paymentId` e o legado `PATCH /orders/:id/payment` em `waiter, manager`; `PATCH /orders/:id/cancel` em manager-only; refund de gateway manager-only; abertura/adição/remoção de itens e atualização de cozinha sem Caixa. Tentativa de fechamento só ocorre depois do callback de pagamento concluído, nunca ao exibir QR Pix.

### Endpoints genéricos: hardening sem quebrar consumidores

Hoje `GET /orders`, `GET /orders/:id` e `GET /tables` usam auth, mas não têm guard explícito por papel. Aplicar allowlists, validando consumidores existentes:

- `GET /orders`: waiter/manager/kitchen (o KDS usa a lista aberta; manter seu acesso).
- `GET /orders/:id`: waiter/manager, salvo consumidor legítimo identificado em busca no frontend/backend.
- `GET /tables`: waiter/manager.
- `PATCH /orders/:id/items/:itemId`: guard de rota waiter/kitchen/manager e manter a validação mais específica por transição no caso de uso.

Criar testes de regressão por perfil antes de mergear os guards. A tela nova do Caixa não deve chamar o GET genérico para receber a ficha completa.

## 5. Checklist por agente

### Agente A — Backend: consulta segregada, autorização e eventos

- [ ] Registrar o contrato HTTP acima e verificar os consumidores reais das rotas genéricas antes de mudar os guards.
- [ ] Criar `backend/src/application/order/cashier-collections.usecases.ts` (ou local equivalente aprovado) para listar/resumir contas `balcao` sem N+1 e sem serialização excessiva.
- [ ] Implementar `backend/src/http/routes/cashier-collections.routes.ts`, com auth, `requireRole("cashier", "manager")`, schema Zod dos query params e `ensureTenantScope`.
- [ ] Registrar o plugin em `backend/src/http/server.ts`.
- [ ] Alterar `backend/src/http/routes/order.routes.ts` nos três guards de pagamento/fechamento definidos e nos GETs genéricos; preservar o KDS e as regras por transição dos itens.
- [ ] Fazer a consulta calcular elegibilidade e status com a lógica autoritativa do backend; evitar recomputar o total com preço atual do produto.
- [ ] Adicionar/validar a sala `cashier:collections` em `backend/src/http/routes/realtime.routes.ts`: handshake/`join` apenas cashier/manager.
- [ ] Publicar eventos minimizados (ID + evento, sem dados de cliente/pagamento) quando uma comanda local entra/atualiza/sai da fila: itens adicionados, última entrega, pagamento alterado/confirmado e comanda fechada.
- [ ] Assegurar que o Caixa continua recebendo `cash-drawer` e não consegue entrar em `kitchen-display`.
- [ ] Atualizar `docs/agent-api-index.md` e mapa de rotas/guia backend com o novo contrato e as allowlists.
- [ ] Não editar `schema.ts`, criar migration ou adicionar tabelas de rateio.

### Agente B — Frontend: entrada e fluxo do Caixa

- [ ] Adicionar item **Cobranças** ao menu de cashier em `frontend/src/app/providers/nav/menuSections.js`; atualizar `menuSections.test.js` (rótulo, ordem e perfis sem acesso).
- [ ] Adicionar o mapeamento de tela em `frontend/src/pages/cashier/CashierApp.jsx`; manter `CashDrawerTab` e `CustomersTab` sem misturar responsabilidades.
- [ ] Criar `frontend/src/pages/cashier/CashierCollectionsScreen.jsx` (ou componente equivalente na estrutura aprovada), com lista, busca, estados de vazio/erro/loading, paginação, ordenação e grupo de itens bloqueados.
- [ ] Criar funções client separadas, por exemplo `frontend/src/entities/order/api/cashierCollections.js`; não apontar essa página a `listOrders()`/`getOrder()` para obter DTO completo.
- [ ] Criar cartão da fila com mesa/comanda, nome estritamente necessário, atendente, minutos de espera, total e CTA explícito **Cobrar**.
- [ ] Ao selecionar, carregar o detalhe dedicado e reutilizar `PaymentModal` com `storeSettings`/métodos habilitados de `useAuth`; não duplicar `round2`, cálculo de total, troco ou lógica de Pix.
- [ ] Preservar apenas o comportamento atual do helper “Dividir igualmente”, se o modal for reutilizado; mesma forma de pagamento nas linhas, total completo no lote, sem pessoa/itens associados. Não adicionar seletor de participante, rateio de itens ou pagamentos independentes.
- [ ] Consultar `/cash-drawer/current`; se não houver sessão, impedir o método Dinheiro no contexto do Caixa e indicar como abrir a gaveta. A validação do servidor continua obrigatória.
- [ ] No callback de pagamento completo, fechar usando `closeOrder()` uma única vez; bloquear duplo toque, exibir andamento, remover da fila após sucesso e manter a conta/contexto se o fechamento falhar.
- [ ] Tratar `pending_items`, `payment_not_registered`, `payment_not_confirmed`, `invalid_payment_total`, `cash_drawer_not_open`, erro de rede e 403 com mensagem acionável.
- [ ] Fazer o refetch ao receber evento `cashier:collections` e após reconexão; o evento só invalida a query, não deve mudar estado financeiro no cliente.
- [ ] Criar testes de tela/API mockada para busca, seleção, retorno, métodos desabilitados, Pix pendente, fechamento e erros. Verificar mobile e desktop.

### Agente C — Backend QA: perfil, pagamentos e regressões

- [ ] Atualizar `backend/test/profiles.test.ts`: cashier/manager acessam as rotas novas; waiter/kitchen/courier recebem 403; manter gerente/garçom/KDS nas rotas antigas corretas.
- [ ] Cobrir que cashier não abre comanda, lança/deleta item, marca pronto/entregue, cancela pedido, apaga linha de pagamento, cria refund nem lê DTO genérico não autorizado.
- [ ] Criar `backend/test/cashier-collections.test.ts`: filtro `balcao`, estados ready/blocked, ordenação, paginação, busca e campos minimizados (sem telefone/endereço/notas privadas).
- [ ] Cobrir tenant A não vê nem cobra pedido do tenant B; caso de uso de detalhe valida status/channel e evita ID arbitrário fora do escopo.
- [ ] Em `payment-lines.test.ts`/`order-flow.test.ts`, validar PUT do Caixa com soma completa, métodos desabilitados, preservação de linhas confirmadas, troco, Pix pendente/confirmado, confirmação idempotente, gaveta fechada para dinheiro e fechamento somente após entrega + pagamento confirmado.
- [ ] Testar retry de fechamento e corrida entre refresh, confirmação e fechamento; nenhuma cobrança ou evento duplicado.
- [ ] Testar realtime: `cashier:collections` negado aos demais papéis, `kitchen-display` negado ao Caixa e payload sem PII/linhas financeiras.

### Agente D — Integração, usabilidade e entrega

- [ ] Fazer revisão conjunta do contrato backend/frontend antes de integrar; resolver nomes/campos do DTO sem ampliar o payload.
- [ ] Executar a suíte backend relevante e completa: `cd backend && pnpm test`.
- [ ] Executar testes/lint/build do frontend: `cd frontend && pnpm test`, `pnpm lint`, `pnpm build`.
- [ ] Revisar manualmente largura mobile (360–430 px) e desktop; alvos de toque, teclado/foco, contraste, rótulos além de ícones e botão inferior sem cobrir o total.
- [ ] Simular sequência de 5–8 contas; busca por mesa, lista vazia, conta bloqueada, pagamento exato, dinheiro/troco, gaveta fechada, cartão, Pix pendente e rede interrompida.
- [ ] Confirmar que a fila atualiza sem reload total, que a conta paga some apenas depois de fechamento confirmado e que voltar do checkout preserva busca/scroll.
- [ ] Atualizar o checklist para `[x]` somente após teste executado e anexar resumo dos comandos/resultados; não marcar por inspeção de código.

## 6. Critérios de aceite (Definition of Done)

- [ ] Caixa vê Cobranças como tela independente; gaveta continua com seu fluxo atual.
- [ ] Lista e detalhe vêm dos endpoints segregados e não retornam campos pessoais/operacionais desnecessários.
- [ ] Busca/paginação/refresh funcionam em celular e desktop; estado de conexão e erro são compreensíveis.
- [ ] Caixa pode registrar e confirmar o fluxo atual de pagamento; total registrado precisa fechar o total da comanda.
- [ ] Dinheiro sem gaveta aberta é bloqueado de modo explicativo; o backend também recusa.
- [ ] Uma comanda não fecha com item pendente, Pix não confirmado, pagamento ausente ou total divergente.
- [ ] Sucesso fecha a comanda, libera mesa pela lógica atual e tira a linha da fila; eventos repetidos não duplicam ações.
- [ ] Waiter continua lançando itens/servindo/fechando normalmente; KDS ainda lista e atualiza seus pedidos; manager mantém acesso operacional.
- [ ] Courier e kitchen não podem consultar a fila financeira; waiter não recebe a tela do Caixa.
- [ ] Nenhuma migration, tabela de split/participant/allocation/tender ou pagamento incremental foi criada nesta fase.
- [ ] Testes, lint e build relevantes passam; documentação da API e do comportamento acompanha o código.

## 7. Fora de escopo / backlog explícito

- Rateio independente por participante, nomes de pagadores ou comprovantes por pessoa.
- Rateio ou atribuição financeira por item/quantidade.
- Pagamento de parcelas em momentos diferentes; saldo parcial persistido por pessoa.
- Novas tabelas/migration de split ou alteração de `order_payment`/`payment` para rateio.
- Novo checkout de adquirente/Pagar.me no Caixa; usar o fluxo já existente nesta entrega.
- Cancelamento/estorno pelo perfil Caixa, alteração de itens ou ação de cozinha.
- Reestruturação do OrderBoard do garçom ou do `CashDrawerTab`.

## 8. Nota para os agentes sobre a árvore de trabalho

No início do trabalho, executar `git status --short` e preservar alterações já existentes. A análise desta sessão encontrou alterações pendentes em `frontend/src/shared/components/ScreenHeader.jsx`, `ScreenHeader.test.jsx` e `frontend/src/features/orders/AddItemScreen.jsx`, além do estudo de usabilidade não versionado. Não descartar, reverter, formatar em massa nem misturar essas alterações sem revisão explícita. O plano novo deve ser implementado em alterações pequenas, cada uma com testes.
