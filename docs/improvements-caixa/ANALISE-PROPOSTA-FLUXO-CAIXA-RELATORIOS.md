# Análise e proposta — pagamento, caixa, relatórios e telas

**Repositório:** `vinihss/pdv-completo`  
**Revisão analisada:** `585e2eb` (`main`, 2026-10-09)  
**Escopo:** leitura estática do frontend, backend e documentação do repositório. Este documento é uma proposta; não altera a aplicação nem representa medições com operadores em loja.

## Resumo executivo

O sistema já tem uma base operacional melhor que a média para um PDV: pagamento pode ser fracionado, a tela calcula valores faltantes e troco, Pix tem etapa explícita de confirmação, pagamento em dinheiro depende de caixa aberto, a sessão de caixa é única e há trilha de auditoria e relatórios separados para vendas e conferência de caixa.

O próximo passo não deveria ser simplesmente acrescentar gráficos. **Primeiro é necessário reforçar a confiança nos lançamentos e no fechamento; depois, deixar o fluxo mais guiado; por fim, ampliar os relatórios.** Os pontos mais importantes que encontrei:

1. **Fechamento de caixa pré-preenche o valor contado com o valor esperado.** Isso facilita confirmar sem realizar a contagem física e pode esconder uma divergência.
2. **Sangria e suprimento são registros simples, com motivo opcional e sem classificação operacional.** O resumo atual ajuda, mas faltam contexto, comprovação e controles proporcionais ao valor.
3. **Há um risco de concorrência a cobrir:** sangrias simultâneas podem calcular o mesmo saldo disponível, pois a operação lê o caixa/movimentos e então insere o movimento sem bloquear a linha da sessão. A regra de não retirar mais do que o disponível deve ser protegida também contra chamadas simultâneas.
4. **Os relatórios financeiros ainda não equivalem a uma DRE nem a uma conciliação de repasse.** O fechamento do iFood grava o total do pedido como pagamento, sem uma entidade de comissão/repasse líquido; cancelamentos e estornos também não formam um ledger completo de reembolsos.
5. **A tela inicial do gerente é um resumo de vendas fechadas, não um painel da operação ao vivo.** É atualizada ao entrar ou manualmente e não evidencia caixa, pendências ou exceções operacionais.

## O que já existe e vale preservar

- `PaymentModal.jsx` permite combinar meios e valores, confere se a soma fecha com o total e calcula troco em dinheiro; Pix permanece pendente até o operador confirmar o recebimento.
- O backend bloqueia a confirmação de recebimento em dinheiro quando não há gaveta aberta. Sangria não pode exceder o esperado e cancelamento de venda em dinheiro gera movimento relacionado ao pedido.
- O caixa calcula o esperado a partir do fundo inicial, recebimentos em dinheiro confirmados e movimentos, e recalcula esse valor no fechamento.
- Há histórico de sessões, detalhe imprimível do fechamento, auditoria e realtime para atualização do caixa.
- Os relatórios já estão separados por propósito: **Visão geral**, **Pedidos**, **Entregas** e **Fluxo de caixa**. Manter essa separação é melhor do que voltar a juntar tudo numa tela longa.

Referências: `docs/04-cash-flow.md`; `frontend/src/features/orders/PaymentModal.jsx`; `backend/src/application/cash-flow/cash-flow.usecases.ts`; `frontend/src/pages/manager/ManagerApp.jsx`.

## Diagnóstico por fluxo

### 1. Pagamento

**Hoje:** a modal aceita dinheiro, cartão, Pix e outro; permite divisão da conta; valida soma e troco. Pix tem QR e confirmação explícita. O cartão, porém, é uma categoria única, sem débito/crédito, parcelas ou identificação da maquininha/transação. Não há, no próprio resumo da cobrança, distinção entre venda bruta, taxa de canal e valor líquido a receber.

**Proposta de processo e usabilidade**

1. **Começar com uma escolha de ação clara:** “Receber o total” (atalho) ou “Dividir pagamento”. Em uma conta de R$ X, o botão do meio escolhido preenche o saldo restante; a divisão continua disponível, mas não ocupa espaço visual quando não é necessária.
2. **Mostrar sempre o quadro de conferência:** total da conta, valor já alocado, falta/excesso, dinheiro recebido e troco. Manter a validação atual, mas usar centavos inteiros no cálculo e na apresentação consistente.
3. **Cartão com detalhes úteis à operação:** débito/crédito, número de parcelas quando aplicável, adquirente/maquininha e referência opcional. Evitar registrar dado sensível do cartão; guardar somente referência não sensível necessária à conciliação.
4. **Pix com estados inequívocos:** “QR gerado”, “aguardando confirmação do operador” e “confirmado”. Incluir botão copiar código Pix e instrução de fallback; nunca tratar a exibição do QR como prova de recebimento.
5. **Erro acionável:** se dinheiro for escolhido sem caixa aberto, orientar “Abra o caixa para confirmar dinheiro” e encaminhar caixa/gerente à tela de abertura, preservando os dados preenchidos. Não reduzir o bloqueio de backend.
6. **Evitar duplicidade em falha de rede/duplo toque:** garantir `correlationId` idempotente para registrar, confirmar e remover/ajustar linhas de pagamento; mostrar estado “verificando” em retry em vez de pedir para o operador lançar tudo de novo.
7. **Não misturar pagamento do cliente com liquidação de canal:** pedidos pagos online por marketplace devem ter “pago pelo canal” e conciliação própria; não devem parecer dinheiro recebido pela gaveta nem valor já repassado ao estabelecimento.

**Critérios de aceite sugeridos:** para cada meio de pagamento, o total distribuído deve fechar exatamente com a conta; dinheiro exige gaveta aberta no momento de confirmação; Pix só fecha após confirmação explícita; retry não duplica lançamento; o resumo identifica claramente cada parcela e seu estado.

### 2. Abertura de caixa

**Hoje:** há fundo inicial numérico, observação opcional e abertura rápida. A tela informa sessão aberta/fechada, operador, horário e duração. Existe uma sessão global por vez.

**Proposta**

- Trocar o valor inicial genérico por uma **contagem de abertura**, idealmente por cédula/moeda, somada automaticamente. Manter opção “informar total” apenas como alternativa acessível/configurável.
- Exibir confirmação prévia: loja/caixa, operador, data operacional, fundo informado e aviso de que esse valor passa a compor o esperado.
- Se já houver sessão aberta, mostrar **quem abriu, quando, valor esperado e ações permitidas** (retomar/ir ao caixa ou solicitar fechamento); não apenas uma mensagem de erro ao tentar abrir outra sessão.
- Incluir checklist curto configurável de abertura: conferir gaveta, fundo, bobina/impressora e confirmar responsável. Evitar transformar o fluxo em formulário longo.
- Para lojas com mais de uma gaveta, modelar caixas físicos/terminais e transferências entre gavetas; a regra atual de uma única sessão global é adequada apenas para a operação de uma gaveta.

### 3. Sangrias e suprimentos

**Hoje:** valor é informado manualmente, o saldo restante é mostrado para sangria e o backend impede ultrapassar o disponível. Nota é opcional; existe confirmação quando a sangria zera o esperado.

**Proposta**

- Tornar **motivo/categoria obrigatório** para sangria e suprimento: depósito/cofre, pagamento de despesa, troco, correção/estorno, reforço de troco, outro. Para “outro”, exigir descrição curta.
- Mostrar em destaque: saldo antes, valor movimentado e saldo previsto depois. Para sangria, reforçar a pessoa que recebe/destino e produzir comprovante com hora, operador, valor, motivo e identificador.
- Definir alçadas configuráveis: acima de um valor, exigir autorização de gerente/PIN e justificativa; não bloquear valores pequenos sem necessidade operacional.
- Não editar ou apagar movimentação financeira já confirmada. Corrigir com movimento compensatório auditável, com referência ao original.
- **Proteger o saldo com serialização no backend:** bloquear a linha da sessão aberta (ou adotar mecanismo equivalente) durante cálculo e gravação do movimento; testar duas sangrias concorrentes cujo total excede o disponível. Definir a mesma disciplina para a corrida entre fechamento e confirmação de pagamento em dinheiro.

### 4. Fechamento de caixa

**Ponto crítico observado:** `CloseCashDrawerModal.jsx` inicializa `counted` com `expected.toFixed(2)`. O operador pode abrir o modal e fechar sem fazer uma contagem física.

**Proposta de processo**

1. Iniciar a contagem com **campo em branco** ou uma contagem de cédulas/moedas zerada, nunca copiando o valor esperado como se fosse o valor contado.
2. Permitir informar quantidades por denominação; calcular total contado automaticamente e oferecer alternativa de total manual.
3. Fazer o operador revisar um quadro “esperado / contado / diferença” somente depois da contagem. A diferença deve aparecer em valor absoluto e sinalizado como falta/sobra.
4. Exigir justificativa quando a diferença ultrapassar tolerância configurável; registrar a justificativa e, se aplicável, aprovação do gerente. Para diferença zero, a nota permanece opcional.
5. Encerrar novos recebimentos de dinheiro durante a etapa final (ou apresentar confirmação clara se outra venda em dinheiro chegar durante a conferência). O backend precisa recalcular o esperado dentro da transação, como já faz, e responder com conflito/novo valor se a conferência ficou desatualizada.
6. Ao concluir, mostrar um **resumo Z** antes da impressão: fundo, vendas em dinheiro, suprimentos, sangrias, esperado, contado, diferença, datas, operadores e observação. Oferecer reimpressão no histórico.

**Critério prioritário:** nunca permitir que o valor contado venha pré-preenchido pelo esperado; toda diferença acima do limite precisa de justificativa auditada; o fechamento deve ser consistente mesmo com pagamento ou movimento concorrente.

## Tela inicial e outras telas

### Tela inicial do gerente

**Hoje:** quatro indicadores — vendas de hoje, comandas fechadas, ticket médio e comandas abertas — carregados na entrada ou via botão. “Vendas de hoje” considera comandas fechadas. Atalhos são genéricos e não mostram estado da operação.

**Evoluir para uma home em duas camadas:**

- **Agora (operacional):** estado do caixa (aberto/fechado, operador, esperado e tempo aberto), comandas antigas/em risco, pedidos aguardando cozinha/expedição, entregas atrasadas e alertas de integração/estoque quando habilitados. Cada cartão deve levar diretamente à ação para resolver.
- **Hoje (resultado):** vendas confirmadas/fechadas, pedidos, ticket médio, vendas por canal, mix de pagamento e comparação com o mesmo dia da semana anterior ou meta da loja. Diferenciar números em tempo real dos números encerrados e informar “atualizado às …”.
- Atualização automática seletiva para os dados operacionais via realtime e ação manual de atualizar para os demais; evitar uma tela que pareça ao vivo sem ser.
- Colocar ações primárias contextuais no topo: “Abrir caixa” se estiver fechado; “Ir para caixa” se aberto; “Ver pedidos atrasados”; “Abrir comandas”.
- Personalizar atalhos por papel e frequência, mantendo os recursos administrativos menos usados em navegação secundária.

### Tela do Caixa

- Separar visualmente **resumo da sessão** (esperado e composição), **ações financeiras** (sangria/suprimento/fechar) e **movimentações**.
- Ordenar movimentações da sessão por horário e facilitar busca/filtragem por tipo, operador e motivo.
- Destacar o operador da sessão atual, não só quem abriu; a sessão hoje não representa necessariamente troca de turno.
- Acrescentar contagem e filtros no histórico, e realçar sessões com divergência pendente de justificativa.

### Outras telas

- **Pedido/Comanda:** manter a revisão do total e itens pendentes antes de cobrar; criar estados visuais mais distintos entre pendente, Pix aguardando confirmação e pagamento confirmado.
- **Pedidos/relatórios:** datas legíveis no fuso da loja, filtros rápidos consistentes e exportação CSV para conciliação.
- **Cadastro/meios:** permitir separar cartão débito/crédito e cadastrar adquirente sem capturar dados sensíveis.
- **KDS/entregas:** adicionar indicadores de pedidos envelhecidos e filtro de canal, conectando a fila operacional à home.

## Relatórios a adicionar ou evoluir

O repositório já tem overview, pedidos, entregas e fluxo de caixa. A proposta é **ampliar com definições financeiras consistentes**, não duplicar relatórios sob novos nomes.

| Relatório | Conteúdo coerente | Dependências / ressalvas |
|---|---|---|
| **Fechamento diário por turno** | Fundo; dinheiro recebido; suprimentos; sangrias; esperado; contado; sobra/falta; operador que abriu/fechou; horários; observações e comprovantes. | Melhorar a contagem e, se houver troca de turno, modelar turno explicitamente. |
| **Conciliação de pagamentos** | Vendas por forma (dinheiro, Pix, débito, crédito, outro), valores confirmados/pendentes, troco, referência de maquininha, taxas e status de repasse. | Distinguir venda registrada de dinheiro efetivamente recebido; adicionar settlement/adquirente e taxas antes de chamar o valor de líquido. |
| **Vendas por canal** | Salão, balcão, delivery próprio, iFood/outros; bruto, desconto, cancelamento/estorno, comissão/taxa, repasse previsto e recebido. | Criar ledger de liquidação por canal e reembolso; hoje pedidos de canal podem gravar o valor bruto sem comissão. |
| **Desempenho por atendente/operador** | Comandas e valor atribuídos, ticket, vendas canceladas/estornadas, tempo até pagamento e diferença de caixa por sessão. | Definir atribuição em transferência/troca de operador e distinguir quem abriu, recebeu e fechou. |
| **Curva de movimento** | Vendas/pedidos por hora e dia da semana, ticket e canais; comparar período atual com período equivalente anterior. | O overview já tem série por hora/dia; incluir comparação justa, canais e política consistente de data operacional. |
| **Produtos e margem** | Quantidade, receita, custo, margem em valor/percentual, cancelamentos e itens sem custo cadastrado. | Custo ausente está sendo tratado como zero em algumas agregações; marcar cobertura do custo e não inferir margem confiável com dados incompletos. |
| **SLA de cozinha e entrega** | Tempo entre lançamento, preparo, pronto, saída e entrega; percentual dentro da meta; mediana e p90 por canal/produto. | Capturar timestamps de etapa. Sem isso, não apresentar estimativas históricas como fato. |
| **Exceções operacionais** | Caixas sem fechamento, divergências, comandas abertas há muito tempo, pedidos atrasados, pagamentos pendentes, integração desconectada, estoque crítico. | Começar como lista acionável; alertas devem ter limiar configurável, link de ação e estado resolvido. |

### Definições para evitar relatórios contraditórios

- **Venda bruta:** valor dos itens efetivamente vendidos + entrega, excluindo itens cancelados; exibir descontos separadamente quando existirem.
- **Cancelamento/estorno:** não apagar a venda do histórico; registrar evento de estorno/refund relacionado ao pagamento original e refletir o valor negativo na visão líquida. Estornos Pix/cartão requerem estado de solicitação/conciliação, não uma sangria de gaveta.
- **Caixa esperado:** dinheiro físico esperado na gaveta, não faturamento total. Pix, cartão e repasse de marketplace não aumentam o numerário da gaveta.
- **Repasse líquido:** bruto menos comissão, taxas e ajustes do canal/adquirente; só exibir como confirmado após conciliação ou indicar explicitamente que é previsto.
- **Lucro/margem:** mostrar apenas quando custo dos produtos e demais componentes necessários forem confiáveis. O relatório de pedidos atualmente mostra ausência de custo em alguns itens, mas qualquer painel agregado deve preservar esse aviso.
- **Dia de operação:** definir data operacional e fuso da loja, especialmente para restaurante que vende após meia-noite. A sessão de caixa pode cruzar dias; relatório por interseção de horários não substitui `business_date`.
- **Cancelamentos e valores pendentes:** sempre separar de vendas fechadas/confirmadas. Não somar “esperado em sessão aberta” com “contado de sessões fechadas” como se fossem a mesma medida.

## Priorização recomendada

### P0 — Integridade financeira e confiança

1. Alterar fechamento para contagem explícita sem valor pré-preenchido; registrar contagem por denominação e política de justificativa por divergência.
2. Serializar sangria/fechamento/pagamento concorrentes e criar testes de corrida e retry.
3. Revisar idempotência de registrar/confirmar/remover pagamentos; a documentação de usabilidade marca esses endpoints como ponto a validar.
4. Definir fluxo de estorno/refund por meio de pagamento, mantendo venda e reversão rastreáveis.
5. Implementar conciliação de settlement/taxas de canal antes de publicar receita líquida ou DRE.

### P1 — Melhorar operação cotidiana

6. Guiar abertura e fechamento com resumo, operador, fundo/contagem e comprovante.
7. Classificar sangrias/suprimentos e introduzir alçadas configuráveis com recibo.
8. Simplificar cobrança comum para poucos toques e detalhar débito/crédito; manter divisão e Pix como fluxos avançados.
9. Criar painel “Agora” na home com status do caixa e exceções resolvíveis.

### P2 — Relatórios gerenciais

10. Adicionar fechamento diário por turno e conciliação de pagamentos.
11. Criar relatório por canal com bruto, taxas, estornos e repasse; só depois consolidar em resultado líquido.
12. Evoluir desempenho por atendente, curva horária, SLA e exceções com base em timestamps e regras de data operacional.
13. Exportar CSV e permitir comparação equivalente entre períodos; aplicar filtros no banco quando o volume crescer.

## Métricas para validar o resultado

Fazer uma linha de base antes de redesenhar e medir após piloto na loja:

- tempo mediano para registrar um pagamento simples e um pagamento dividido;
- número de toques/edições por fechamento;
- percentual de caixas com divergência e valor absoluto mediano da diferença;
- fechamento feito sem justificativa quando há diferença;
- sangrias corrigidas/estornadas e tentativas negadas por saldo insuficiente;
- taxa de retry/duplicidade de pagamento e erro de conciliação;
- tempo para o gerente identificar e agir numa exceção;
- taxa de cobertura dos custos de produto nos relatórios de margem.

Não atribuir metas numéricas antes de observar volume, dispositivo e processo reais. Usar teste de usabilidade com caixa/gerente e simular perda de rede, reenvio, duas sangrias concorrentes e venda em dinheiro durante fechamento.

## Referências principais do código

- `frontend/src/features/orders/PaymentModal.jsx` — linhas de cálculo, divisão, seleção dos meios e confirmação Pix.
- `frontend/src/widgets/cash-drawer/CloseCashDrawerModal.jsx` — valor contado inicializado a partir do esperado.
- `frontend/src/widgets/cash-drawer/CashMovementModal.jsx` — campos e confirmação de sangria/suprimento.
- `frontend/src/widgets/cash-drawer/CashDrawerTab.jsx` — status, movimentos e histórico do caixa.
- `backend/src/application/cash-flow/cash-flow.usecases.ts` — cálculo esperado, gravação de movimentos, abertura, fechamento e resumo.
- `frontend/src/pages/manager/tabs/home/ManagerHome.jsx` — KPIs e atalhos da tela inicial.
- `frontend/src/pages/manager/tabs/reports/` — relatórios atuais de visão geral, pedidos, entregas e caixa.
- `backend/src/application/report.usecases.ts` — vendas fechadas, mix por método e custos de produto.
- `backend/src/application/report-overview.usecases.ts` — séries e agregação da visão geral.
- `backend/src/integrations/ifood/status-pushback.ts` — registro do total do pedido concluído pelo iFood.
- `docs/04-cash-flow.md` e `docs/14-usabilidade-e-processos.md` — especificações e backlog existente, úteis para evitar duplicação de decisões.

**Limite da análise:** não alterei nem publiquei código no GitHub, não acessei banco de produção e não executei a suíte de testes; as conclusões são uma revisão estática da revisão indicada acima.
