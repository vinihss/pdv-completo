# Estudo de interface e usabilidade — Comandas do garçom

**Repositório analisado:** `vinihss/pdv-completo`  
**Data da análise:** 9 de outubro de 2026  
**Escopo:** fluxo do perfil de garçom: localizar/abrir comanda, lançar itens, acompanhar cozinha, entregar itens, receber pagamento e fechar.  
**Método:** inspeção estática do frontend e de seus contratos aparentes; não houve teste com garçons, medição em dispositivo real nem validação do comportamento visual em execução. As recomendações abaixo devem ser validadas em campo antes de serem tratadas como conclusão de pesquisa com usuários.

## Resumo executivo

A solução já cobre boa parte do ciclo operacional: abertura de comanda por mesa/cliente/rótulo; busca e categorias de produtos; opções/variações, observações e revisão do carrinho; estados de cozinha; atualização em tempo real; pagamentos divididos e cálculo de troco. A base funcional é boa.

O maior ganho de usabilidade não parece vir de acrescentar mais funcionalidades, mas de **manter o garçom no contexto da mesa e reduzir passos, decisões e ambiguidades nas ações críticas**. Encontrei dois pontos especialmente prioritários:

1. **Após confirmar o lançamento, a tela fecha o detalhe da comanda e volta à lista.** Isso interrompe a tarefa e obriga o garçom a localizar/reabrir a comanda para conferir o envio ou seguir atendendo.
2. **Quando ainda não há pagamento, “Registrar pagamento e fechar” abre o pagamento; após salvar, a comanda permanece aberta e é necessário tocar “Fechar conta” novamente.** O texto promete uma conclusão em uma etapa, mas a interação pede duas.

Também merecem atenção o gesto implícito de tocar uma linha inteira para marcar um item como entregue, a descoberta do estado de cada item e o modo de abrir comanda por mesa sem contexto espacial do salão.

## Jornada observada no código

1. **Lista de comandas:** filtro inicial em “Abertas”; busca, filtros adicionais e três modos de visualização; botão flutuante para nova comanda.
2. **Abertura:** escolha entre mesa, cliente e rótulo. A seleção de mesa é uma grade de números; mesas ocupadas ficam desabilitadas. Ao abrir, o app entra no detalhe.
3. **Lançamento:** tela cheia de produtos com busca e categorias; toque adiciona o produto ou abre opções; o carrinho é revisado em modal e enviado em lote.
4. **Cozinha/entrega:** mudanças chegam por atualização direcionada em tempo real; itens prontos ficam destacados na lista. No detalhe, tocar um item pronto (ou “ordered” quando não há cozinha configurada) muda seu estado para entregue.
5. **Pagamento:** modal admite mais de uma forma de pagamento, divisão igual, conferência do total, dinheiro recebido/troco e confirmação manual de Pix após exibição do QR.
6. **Fechamento:** depende de não haver itens pendentes. Quando não há pagamento, o botão abre o modal de pagamento; depois do registro, uma segunda ação ainda fecha a comanda.

Referências principais: `frontend/src/widgets/order-board/OrderListScreen.jsx`, `OrderBoard.jsx`, `OrderDetailScreen.jsx`, `frontend/src/features/orders/AddItemScreen.jsx`, `ReviewCartModal.jsx`, `NewOrderModal.jsx` e `PaymentModal.jsx`.

## O que já funciona bem

- **Ações centrais visíveis:** “Adicionar item” e fechamento ficam fixos na parte inferior do detalhe, reduzindo procura em listas longas.
- **Lançamento em lote com revisão:** permite montar o pedido, conferir total/observações e só então confirmar.
- **Barreiras contra erros financeiros:** o botão de salvar pagamento depende de os valores fecharem com o total; dinheiro recebido é validado e o troco é calculado.
- **Feedback de cozinha:** itens prontos recebem destaque visual e a tela se atualiza por WebSocket, com REST como fonte da verdade.
- **Proteções de domínio:** conflitos de atualização são tratados; fechamento bloqueia itens pendentes; exclusões pedem confirmação.
- **Flexibilidade operacional:** mesas, clientes e comandas sem mesa; catálogo com variações; pagamentos mistos e divisão igual.

Esses elementos devem ser preservados enquanto se simplifica a sequência de uso.

## Achados e recomendações priorizadas

### P0 — Permanecer na comanda depois de lançar itens

**Evidência:** `OrderBoard.jsx`, `handleItemsConfirmed`, define `openOrderId` como `null`, mostra toast e recarrega a lista depois da confirmação do lote (`frontend/src/widgets/order-board/OrderBoard.jsx`, aprox. linhas 52–56). `OrderDetailScreen.jsx` entrega esse callback após confirmar o lançamento.

**Impacto provável:** quebra o fluxo mental “estou atendendo esta mesa”; acrescenta navegação e busca repetidas; em salão movimentado aumenta o risco de voltar à comanda errada ou esquecer o acompanhamento.

**Recomendação:** após confirmação, atualizar a comanda e **continuar no detalhe da mesma comanda**, com feedback curto e explícito, por exemplo: “4 itens enviados para a cozinha”. Retornar à lista deve ser uma decisão do garçom, não um efeito colateral.

**Critério de aceite:** lançar itens não muda a comanda ativa; total, itens e estados atualizam sem reabrir a tela.

### P0 — Fazer “Registrar pagamento e fechar” cumprir o que promete

**Evidência:** `handleClose` abre `PaymentModal` quando não há pagamentos; em `onConfirmed`, o modal fecha e `onReload()` atualiza, mas não chama `closeOrder`. O garçom tem de tocar novamente em “Fechar conta” (`OrderDetailScreen.jsx`, aprox. linhas 81–103 e 274–285).

**Impacto provável:** etapa redundante no momento de maior pressão do atendimento; divergência entre rótulo e resultado; dúvidas sobre se o pagamento foi aceito ou se ainda falta algo.

**Recomendação:** implementar uma sequência única e explícita: **conferir pendências → registrar/confirmar pagamento → fechar → mostrar recibo/resumo e liberar mesa**. Se houver razão de negócio para separar pagamento de fechamento, mudar o primeiro rótulo para “Registrar pagamento” e exibir uma próxima ação clara. Não fechar automaticamente Pix ainda não confirmado nem ignorar pendências de cozinha.

**Critério de aceite:** pagamento confirmado leva a uma confirmação de fechamento sem repetir a ação inicial; Pix pendente mantém a comanda aberta e explica o motivo.

### P1 — Tornar a ação de “entregar item” explícita e recuperável

**Evidência:** a linha inteira do item recebe `onClick`; quando o item está pronto, o toque marca o item como `delivered`. Não há confirmação para essa transição (`OrderDetailScreen.jsx`, aprox. linhas 51–69 e 152–163).

**Impacto provável:** toque acidental em tela pequena pode registrar como entregue uma refeição que ainda está na cozinha/balcão. O estado “entregue” representa um fato operacional, então a ação implícita é arriscada.

**Recomendação:** separar leitura e ação. Exibir botão/CTA inequívoco “Marcar como entregue” no item pronto, com área de toque generosa, estado de carregamento e feedback; não tornar a linha inteira acionável. Considerar desfazer breve ou reversão com registro de auditoria se a operação permitir. Manter a mesma regra também no modo sem cozinha, mas com texto contextual.

**Critério de aceite:** tocar no nome/linha não altera estado; a transição só ocorre por ação rotulada e tem feedback perceptível.

### P1 — Mostrar o trabalho a fazer antes de abrir cada comanda

**Evidência:** cartões exibem mesa/rótulo, quantidade total de itens, total monetário e hora; há destaque para “Pronto para entregar” e “Tudo entregue”, mas não um resumo geral de quantos itens aguardam, estão em preparo ou estão prontos por comanda. Filtro “Com pronto” existe (`OrderListScreen.jsx`).

**Recomendação:** acrescentar um resumo compacto e acionável por comanda, por exemplo **“2 prontos · 3 em preparo”**, com o número de prontos em maior destaque. No topo, considerar chips com contagens (“Abertas 8”, “Prontos 3”), sem competir com o botão de nova comanda. Ao tocar no resumo, abrir o detalhe focado nos itens daquela etapa.

**Nota:** separar claramente estado da comanda (aberta/fechada) do estado dos itens (em preparo/pronto/entregue); evitar codificar status só por cor.

### P1 — Ajudar o garçom a encontrar a mesa certa

**Evidência:** nova comanda apresenta mesas como números em grade, sem mapa, área/setor, capacidade nem legenda de status explícita. Ocupadas ficam desabilitadas; o garçom precisa conhecer a numeração (`NewOrderModal.jsx`, aprox. linhas 95–114).

**Recomendação:** quando a operação tiver mesas, preferir uma **visão de salão por setor**, com estados legíveis (“Livre”, “Ocupada”, “Aguardando conta”), cliente/rótulo e tempo de ocupação. Permitir também busca/seleção numérica rápida como alternativa acessível e para salões sem layout configurado. Não obrigar o estabelecimento a desenhar um mapa para usar o PDV.

**Critério de aceite:** a pessoa localiza a mesa pela posição conhecida ou pelo número; o estado é entendível sem depender apenas da cor.

### P1 — Evitar ambiguidades ao iniciar uma comanda

**Evidência:** `Nova comanda` oferece “Mesa”, “Cliente” e “Rótulo”; o modo inicial é mesa quando a loja usa mesas. O cliente precisa ser selecionado/cadastrado; o rótulo é texto livre.

**Recomendação:** priorizar a escolha mais frequente segundo o restaurante (configurável ou baseada em uso), manter a seleção ocupada/livre evidente, e dar foco inicial à busca de mesa/cliente. Para balcão, apresentar “Balcão/retirada” em linguagem operacional, com geração automática de identificador; manter rótulo livre como opção avançada. Prevenir duplicatas por confirmação visível e orientar a recuperação se a mesa já tiver comanda aberta.

**Cuidado de processo:** uma segunda rodada na mesma mesa pode ser uma nova inclusão na comanda aberta, não uma nova comanda. A interface deve favorecer “continuar a comanda existente”.

### P1 — Tornar o carrinho rápido para pedidos repetidos

**Evidência:** um toque em produto sem variações incrementa a quantidade em uma unidade; o carrinho é aberto depois em “Revisar e confirmar”. O contador mostra quantidade, mas a tela de revisão não oferece controles diretos de +/− (`AddItemScreen.jsx`, `ReviewCartModal.jsx`).

**Recomendação:** manter o toque simples como adição rápida, mas permitir corrigir quantidade com controles `− / +` no carrinho e revisão; indicar visualmente que o toque adicionou uma unidade. Para produtos com opções, preservar a seleção obrigatória e deixar variações diferentes em linhas separadas. Evitar exigir digitação numérica para ajustes comuns.

### P2 — Melhorar leitura, busca e feedback de catálogo

- Dar prioridade a favoritos/mais vendidos recentes, se os dados e as regras do restaurante permitirem, mantendo busca e categorias sempre acessíveis.
- Informar estados de carregamento e falha de catálogo; hoje as falhas de busca inicial são ignoradas (`AddItemScreen.jsx`, aprox. linhas 25–28), o que pode parecer catálogo vazio.
- Na busca, oferecer correspondência por nome e sinônimos cadastrados; preservar filtro e consulta ao voltar da revisão, se compatível com a arquitetura.
- Manter preço, variações e indisponibilidade legíveis; a regra de estoque sem saldo já desabilita o produto quando o controle está ligado.

### P2 — Fazer a lista trabalhar para a operação, não só para consulta

- Tornar o controle de visualização (lista/grade) mais descobrível: atualmente um botão cíclico altera modos e o ícone não descreve todas as opções de uma vez.
- Exibir filtros e contagens com semântica estável; manter “Abertas” como padrão faz sentido para o garçom.
- Incluir acesso direto para “prontos”/“precisam de atenção”, preservando busca por mesa e cliente.
- Definir se comandas fechadas precisam mesmo ficar disponíveis ao garçom; a lista pede até 200 fechadas. Se a consulta histórica não for tarefa frequente, ocultá-las da navegação primária reduz ruído.
- Revisar a busca atual: ela filtra o rótulo da comanda (`orderLabel`), então verificar se cliente e mesa são sempre cobertos pelo rótulo real usado no domínio.

### P2 — Tornar o pagamento orientado à tarefa

**O que já há:** métodos configurados, múltiplas linhas, soma contra total, dinheiro recebido/troco, divisão igual e confirmação de Pix no QR.

**Melhorias:**

- Mostrar total, já pago, restante e troco em um resumo sempre visível; distinguir “valor cobrado” de “valor recebido” em dinheiro.
- Priorizar o meio de pagamento mais usado e lembrar a última seleção apenas se isso não criar risco de cobrança incorreta.
- Na divisão igual, explicitar o arredondamento e oferecer “dividir por pessoa” com ajuste individual; hoje o recurso é divisão automática por quantidade e método.
- Antes de concluir, apresentar confirmação curta do total por método e do estado do Pix. Não registrar Pix como confirmado apenas porque o QR foi exibido.
- Se o cliente desistir do QR ou o pagamento falhar, explicar claramente que não houve confirmação e manter o pagamento/comanda em estado recuperável.

## Jornada-alvo proposta

1. **Salão/lista operacional:** mesas livres e ocupadas distinguíveis; visão imediata de itens prontos e comandas que precisam de ação.
2. **Abrir ou continuar:** selecionar mesa/cliente/rótulo e entrar em uma comanda existente quando aplicável; identificador e contexto sempre visíveis.
3. **Lançar:** buscar/categorizar produto, escolher variações, ajustar quantidade e observações; revisão final em uma tela curta.
4. **Enviar e permanecer:** confirmar lote, receber feedback “enviado para cozinha” e permanecer no detalhe daquela comanda.
5. **Acompanhar e servir:** estados dos itens atualizados sem recarregar; “Pronto” chama atenção; garçom marca “Entregue” por ação explícita.
6. **Fechar:** sistema resume pendências de cozinha e valor; registra uma ou várias formas de pagamento; confirma Pix quando aplicável; fecha a comanda uma vez e informa que a mesa foi liberada.

## Princípios de interface para o dispositivo do salão

- **Projetar para uso em movimento:** alvos de toque grandes, espaçamento entre ações destrutivas e frequentes, uma mão e atenção dividida.
- **Uma ação primária por etapa:** “Adicionar itens”, “Marcar entregue”, “Registrar pagamento”, “Fechar conta” devem ser verbos claros e não conflitar.
- **Contexto persistente:** mesa/rótulo, total e estado atual devem acompanhar o garçom nas telas de detalhe e lançamento.
- **Feedback imediato e recuperável:** cada toque informa se adicionou, enviou, atualizou ou falhou; impedir duplo envio enquanto aguarda a resposta e permitir corrigir o que for reversível.
- **Acessibilidade:** texto e contraste adequados, ícone acompanhado de rótulo, status não dependente apenas da cor, foco e rótulos acessíveis; manter áreas de toque confortáveis no celular/tablet.
- **Conectividade imperfeita:** indicar conexão/última sincronização; em falha, dizer se a alteração foi ou não gravada e evitar repetição que duplique pedido.

## Plano de execução recomendado

### Etapa 1 — Corrigir fricção e risco de erro (primeiro ciclo)

1. Permanecer no detalhe após adicionar itens.
2. Unificar pagamento confirmado e fechamento em um fluxo coerente, respeitando pendências e confirmação de Pix.
3. Substituir toque na linha por ação rotulada de entrega.
4. Melhorar contagens/resumos de prontos e em preparo na lista e no detalhe.

### Etapa 2 — Reduzir tempo de operação

1. Melhorar seleção de mesa/continuação de comanda.
2. Adicionar controles `− / +` e feedback claro de adição no carrinho.
3. Melhorar estados de carregamento/erro no catálogo e o controle de modos de visualização.
4. Otimizar busca e atalho de produtos mais frequentes com telemetria mínima e consentida.

### Etapa 3 — Adaptar ao restaurante

1. Testar mapa do salão opcional/setores e nomes de fluxo configuráveis.
2. Refinar divisão de conta, recibo e política de serviço conforme prática real.
3. Revisar uso de histórico de comandas e necessidade de acesso por perfil.

## Como validar com garçons

Realizar testes moderados no mesmo tipo de celular/tablet e rede usados no serviço. Incluir pelo menos um garçom experiente e um recém-integrado; observar sem ensinar o fluxo. Usar dados fictícios e tarefas realistas:

1. Abrir/continuar uma mesa ocupada pelo próprio atendente.
2. Lançar dois pratos, um com variação, uma bebida e uma observação; corrigir uma quantidade antes de enviar.
3. Achar a mesa com item pronto enquanto outras comandas estão abertas; marcar entrega.
4. Registrar parte em dinheiro e parte em cartão; conferir troco.
5. Receber Pix e fechar; repetir cenário com Pix ainda sem confirmação e com um item pendente.
6. Simular perda momentânea de conexão e recuperação sem duplicar lançamento.

Registrar: sucesso sem ajuda, tempo por tarefa, toques/telas por tarefa, erros (item errado, duplicado, entrega prematura, fechamento incompleto), pedidos de ajuda, esforço percebido e preferência de layout. Comparar versão atual e protótipo/implementação em tarefas equivalentes.

## Métricas após implantação

- Mediana e percentil 90 do tempo: abrir/continuar, enviar lote, registrar pagamento e fechar.
- Toques e mudanças de tela por comanda.
- Taxa de correção/remoção de itens e duplicidades por 100 comandas.
- Proporção de itens prontos aguardando entrega e tempo entre “pronto” e “entregue”.
- Taxa de pagamentos que ficam registrados sem fechamento e comandas abertas após pagamento confirmado.
- Falhas/repetições causadas por conexão, sempre sem registrar dados pessoais além do necessário.

## Decisões de produto a confirmar com a operação

Antes de implementar mudanças maiores, confirmar com o restaurante: quem pode fechar a conta; se garçom pode registrar pagamento em todos os meios; política de serviço/taxa e gorjeta; se uma conta pode ser parcialmente fechada; o que “entregue” significa para cada tipo de item; se atendimento de balcão deve ser fluxo principal; e como mesas/seções são organizadas no salão. Essas regras influenciam a interface, mas não devem bloquear as correções P0 que apenas tornam o comportamento existente consistente e reduzem navegação desnecessária.

## Complemento: leitura da captura de tela móvel

Esta seção parte da captura enviada pelo usuário (viewport aproximado de 507 × 878 px). É uma leitura visual de uma tela específica, não substitui teste em aparelho nem permite concluir comportamento fora do que aparece na imagem.

### O que a captura confirma

- **A lista é utilizável em coluna única**, com cartões de largura confortável, nome/rótulo, número de itens, total e hora. O botão flutuante de nova comanda é fácil de localizar.
- **O estado “pronto para entregar” chama atenção** pelo contorno verde e pelo rótulo explícito, distinguindo-se das comandas sem itens prontos.
- A busca e os filtros estão no topo. A categoria “Cliente” aparece como filtro rápido; filtros adicionais podem exigir rolagem horizontal dependendo da configuração.
- Os alertas de “aberta há mais de 24h” aparecem como triângulo junto ao nome e novamente como texto dentro do cartão.

### Ajustes visuais que eu priorizaria após ver a captura

1. **Diminuir a repetição do alerta de comanda antiga.** O mesmo sinal amarelo aparece junto ao título e em uma segunda linha. Manter uma sinalização principal e usar explicação acessível no detalhe reduz ruído; reservar aviso mais forte para comandas realmente acionáveis (por exemplo, acima de um limite configurado ou com risco de turno).
2. **Dar mais hierarquia à fila de trabalho.** “Pronto para entregar” é o sinal operacional mais urgente; destacar primeiro essa informação e eventualmente exibir “2 prontos” evita que o nome/valor e alertas antigos concorram com a próxima ação.
3. **Revisar o botão flutuante sobre a lista.** Na imagem, o “+” fica sobre a área do cartão inferior. Embora seja uma convenção conhecida, pode encobrir informação ou um alvo de toque. Reservar espaço inferior na lista, posicionar o botão fora dos cartões visíveis ou usar uma ação fixa com rótulo (“Nova comanda”) ajudaria a evitar sobreposição e melhora a descoberta.
4. **Aumentar descoberta dos ícones de cabeçalho.** Os controles de visualização e atualização aparecem como ícones pequenos sem texto. Validar alvos de toque no dispositivo e oferecer rótulo acessível/tooltip; considerar reduzir a importância visual da troca de layout se for uso ocasional.
5. **Verificar o recorte/sobreposição escura à esquerda.** A imagem mostra uma faixa escura vertical que cobre parcialmente a interface, e uma camada escura na parte inferior. Pode ser artefato de captura, menu lateral ou estado visual da aplicação. Não dá para atribuir a causa apenas pela imagem; se for parte do produto, precisa ser removível e não pode reduzir a área útil nem encobrir conteúdo/controles.
6. **Tratar visibilidade do último cartão.** A captura termina com um cartão parcialmente cortado; isso é normal durante rolagem, mas o FAB e qualquer navegação inferior não devem impedir alcançar ações ou leitura do conteúdo no fim da lista. Confirmar `padding-bottom`/safe area em aparelhos reais.

### Ajuste de prioridade resultante

O complemento visual **reforça** a recomendação P1 de priorizar estados prontos e explicita dois itens de refinamento móvel: reduzir a duplicidade visual de alertas de idade e garantir que o botão “+” não cubra conteúdo. A faixa à esquerda fica registrada como ponto a investigar, sem classificá-la como bug até confirmar a origem.


## Redesenho do fluxo para horários de pico

### Objetivo de operação

Reduzir **tempo de atenção por pedido** e idas e voltas entre telas, mantendo confirmação suficiente para evitar erro de mesa, item, variação, valor ou pagamento. O fluxo deve separar o caminho comum (simples e frequente) das exceções (personalização, divisão, Pix não confirmado, pendência operacional).

### A. Lançar pedido: de duas telas/modais para uma tarefa contínua

**Fluxo proposto**

1. **Entrar pela mesa/comanda certa.** Cabeçalho persistente com mesa/rótulo, nome quando houver e total atual. A ação “Adicionar itens” abre a tela de lançamento já vinculada àquela comanda.
2. **Adicionar com toque rápido.** Busca e categorias permanecem acessíveis; toque em item simples adiciona uma unidade imediatamente, com contador e feedback tátil/visual. Toque repetido incrementa quantidade. Produtos com variação obrigatória abrem seleção curta; após confirmar a variação, volta-se ao catálogo preservando a busca e a posição.
3. **Carrinho sempre à mão.** Barra fixa resumida: “4 itens · R$ 86,00 · Revisar e enviar”. No carrinho, controles `− / +`, remoção e observação por linha. Não exigir observação nem campos extras para pedido simples.
4. **Revisão rápida, não um funil.** Exibir apenas linhas, quantidades, modificadores, observações e total. A ação principal é **“Enviar 4 itens para a cozinha”** (ou “Confirmar itens” quando não houver cozinha). Evitar um botão genérico “Confirmar lançamento”.
5. **Confirmação e retorno ao contexto.** Bloquear toque repetido durante a gravação, mostrar “Enviado” e voltar ao detalhe **da mesma comanda**, com o lote recém-lançado destacado e seu estado visível. Não retornar à lista como efeito automático.
6. **Nova rodada é incremental.** Se a mesa já tem pedido, enviar somente os itens novos como novo lote/rodada. Cozinha e garçom devem conseguir distinguir primeira rodada e adicionais sem reimprimir/reapresentar tudo.

**Atalho de pico (opcional/configurável):** para produtos simples e sem variações, permitir “adicionar e continuar”; ainda enviar o lote explicitamente. Não recomendo enviar cada item automaticamente à cozinha por padrão: isso pode fragmentar a produção e criar comandas duplicadas ou tickets difíceis de coordenar. Atalho de envio imediato deve depender de teste e regra do restaurante.

**Resiliência:** se a resposta falhar, preservar o carrinho como rascunho e mostrar estado “Não enviado — tentar novamente”; usar idempotência para que repetição de rede não duplique o lote. Se não houver backend/API para idempotência ou rascunho, tratar como pré-requisito técnico antes de anunciar operação offline.

### B. Pagamento: caminho rápido padrão e caminho flexível

**Caminho comum (conta paga por um meio)**

1. Ação destacada **“Cobrar R$ 86,00”** no resumo da comanda.
2. Escolher uma forma configurada (cartão, dinheiro, Pix, etc.) em um toque. O último método só deve ser priorizado se isso não levar a confirmar um método diferente do efetivamente recebido.
3. **Cartão:** apresentar total exato e confirmação após passar na maquininha; não registrar sucesso antes da confirmação do garçom ou integração confiável.  **Dinheiro:** mostrar valor devido, atalhos de valores comuns (“exato”, notas frequentes) e troco calculado; campo para outro valor continua disponível.  **Pix:** gerar QR/código com valor preenchido e deixar claro “Aguardando pagamento”; confirmar somente após verificação prevista pela operação (integração/retorno confiável ou conferência manual — o QR sozinho não comprova recebimento).
4. Pagamento confirmado gera resumo de método/valor e uma única ação final, **“Concluir e liberar mesa”**, se as regras de serviço estiverem satisfeitas. Não voltar para o início do modal ou pedir repetir “Fechar conta”.
5. Se houver pendência impeditiva, explicar exatamente o que falta e oferecer atalho ao item; jamais simplesmente desabilitar sem explicação.

**Caminho excepcional (divisão ou múltiplas formas)**

“Dividir conta” abre uma segunda camada com divisão igual por pessoas, valores personalizados ou vários métodos. Começar cada parcela com saldo restante preenchido automaticamente; mostrar `Total · Registrado · Falta`. A soma deve bater exatamente. O caminho padrão não deve obrigar todos os garçons a atravessar essa interface.

### C. Resolver a política de pendências antes de automatizar o fechamento

O código atual impede o fechamento enquanto há itens pendentes. Isso pode ser correto para a operação, mas pode conflitar com clientes que querem pagar antes de todos os itens chegarem. Definir com o restaurante uma política explícita:

- **Fechamento estrito:** não aceita fechamento até tudo estar entregue/cancelado; o resumo precisa listar quais itens estão pendentes e permitir resolvê-los.
- **Pagamento antecipado:** aceita registrar pagamento, mas mantém a comanda/mesa em estado distinto de “fechada/liberada” enquanto houver serviço pendente; quando o último item for entregue, conclui/libera automaticamente ou com confirmação, conforme a regra local.

Não marcar como entregue, cancelar item, liberar mesa nem fechar a comanda silenciosamente para acelerar o fluxo. Pagamento recebido e atendimento concluído são estados diferentes, a menos que o domínio os tenha definido formalmente como equivalentes.

### D. Tela de comanda durante o turno

- Cabeçalho fixo: **mesa/rótulo + estado + total devido**.
- Blocos por rodada: “Pedido inicial”, “Adicional 19:42”; status por item com ação “Marcar entregue” bem rotulada.
- Barra inferior com primária contextual: **“Adicionar itens”** enquanto atende; **“Cobrar R$ X”** quando solicitado pagamento; resumo de pronto sem esconder itens e ações.
- Se houver itens prontos, cartão/aviso acionável “2 prontos para entregar” acima da lista, com foco nesses itens — sem desviar automaticamente da comanda.
- Botão de voltar preserva estado de lista, busca e posição de rolagem.

### E. Prioridade de implementação e definição de pronto

**Primeiro ciclo:** permanecer na comanda após envio; resumo e carrinho com `− / +`; botão de envio com quantidade explícita; retorno e feedback no mesmo contexto; pagamento normal em caminho curto; Pix não confirmado não fecha; fechamento sem etapa duplicada; alertas claros de itens pendentes.

**Definições antes de codificar:** política de “pagar antes da entrega”; quem confirma cartão/Pix; quais métodos podem ser registrados pelo garçom; se a mesa só fica livre após serviço; quais produtos precisam de impressão imediata; e como o caixa reconcilia pagamentos divididos.

**Teste de pico:** simular sequência contínua de 5–8 mesas, pedidos iniciais e adicionais, itens com variação, item pronto, pagamento exato, dinheiro com troco, Pix pendente e perda/repetição de rede. Medir tempo ativo do garçom, toques por pedido, erros/duplicidade, tempo do pronto até entrega e proporção de comandas pagas que ficam abertas sem motivo.


## Visão de cobrança do caixa sem sobrecarregar o Caixa atual

### Princípio de separação

A tela atual `CashDrawerTab` tem uma responsabilidade clara: **sessão do gaveteiro** (abrir/fechar, fundo e valor esperado, sangria/suprimento, movimentações e histórico). Não colocar dentro dela cartões de mesas, cozinha, lançamentos de itens ou uma fila extensa de pedidos. Pagamento de comanda e controle físico/financeiro do turno são tarefas próximas, mas não são a mesma tarefa.

No código atual, o papel `cashier` vê `Caixa` e `Clientes`; o papel `manager` vê tanto `Comandas` quanto `Caixa`; o papel `waiter` vê Comandas. Os testes do backend proíbem criação de comandas pelo caixa (`backend/test/profiles.test.ts`, teste de permissões). Logo, se a intenção é dar ao caixa acesso a cobrar/fechar pedidos, isso requer **permissão explícita e endpoints autorizados no backend**, não só um link novo no menu. Não conceder ao caixa acesso ao OrderBoard inteiro por conveniência.

### Estrutura recomendada: área “Cobranças” independente

Adicionar uma tela de primeiro nível chamada **Cobranças**, ao lado de `Caixa` e `Clientes` no menu do perfil, com badge discreto de contas aguardando. A tela de sessão do gaveteiro permanece inalterada. A nova tela usa a mesma identidade visual, mas contém somente pedidos aptos à cobrança.

**Fila de cobranças**

- Busca por número da mesa/comanda, cliente ou código curto.
- Filtro inicial **Aguardando cobrança**, com contagem; histórico/encerradas fica secundário.
- Cada linha/cartão mostra o mínimo para decisão: **Mesa/comanda · cliente · atendente · total devido · status de serviço**.
- CTA único **“Cobrar”** abre o checkout focalizado, sem entrar no detalhe completo do garçom.
- Mostrar status impeditivo com explicação (por exemplo, “2 itens ainda não entregues”); não transformar um cartão bloqueado num checkout quebrado.
- Ordenação padrão por tempo em espera ou prioridade operacional acordada; não misturar comandas pagas/fechadas com a fila ativa.

**Checkout focalizado**

- Contexto e total no topo, com valor restante e pagamentos previamente registrados.
- Atalhos para os métodos habilitados e valor já preenchido; dinheiro com valores rápidos/troco, cartão com confirmação do operador após a maquininha, Pix com estado aguardando e confirmação confiável.
- Divisão em fluxo secundário (“Dividir conta”), não como painel obrigatório.
- Uma ação final consistente: **“Confirmar pagamento”**; após o pagamento, fechar/liberar a mesa automaticamente apenas quando as regras de operação e estado da comanda permitirem.
- Resumo final com mesa, total, formas/valores, troco e impressão/recibo; ao concluir, retornar à fila de cobranças.

### Descoberta sem sobrecarga

Na tela atual do gaveteiro, manter a hierarquia existente e, se houver uma fila ativa, exibir somente um **atalho contextual** no alto — por exemplo, “6 cobranças aguardando” — que leva à tela dedicada. A mesma tela também fica no menu. Não inserir a fila completa, os detalhes de pedidos e ações de cozinha no painel de abertura/fechamento de caixa.

Em desktop, `Cobranças` vira um item irmão no menu do caixa; em celular, aparece como item do drawer. Não duplicar menu de abas persistente dentro da área de gaveta e não esconder ações financeiras dentro de ícones sem rótulo.

### Permissões e integração necessárias

1. Definir exatamente se o caixa pode **consultar, cobrar, confirmar Pix/cartão, fechar e reabrir**; cada permissão deve ser independente e auditável.
2. Criar endpoints de leitura limitados a pedidos aptos à cobrança e endpoints específicos para registrar/confirmar pagamentos; validar o papel em cada operação no servidor. Não reaproveitar uma tela com controles escondidos se o backend continuar permitindo as mesmas chamadas.
3. Garantir idempotência de confirmação para evitar pagamento ou baixa duplicada após toque repetido/reconexão.
4. Sincronizar o pagamento em dinheiro com a sessão correta de gaveta; cartão/Pix não devem inflar o dinheiro esperado na gaveta.
5. Definir a política para itens não entregues: bloquear a cobrança/finalização ou aceitar pagamento antecipado sem liberar a mesa até o serviço acabar. A UI deve distinguir “pago”, “atendimento concluído” e “mesa liberada”.
6. Registrar usuário operador, método, valor, troco, hora e estornos/auditoria conforme as regras de domínio.

### MVP e validação

Começar com uma fila filtrada de “Aguardando cobrança”, busca, checkout de uma forma de pagamento e retorno à fila. Acrescentar divisão e casos excepcionais depois que o fluxo simples for seguro. Testar no celular e no caixa físico: localizar uma conta em poucos segundos, cobrar valor exato, dinheiro com troco, pagamento dividido, Pix ainda pendente, comanda com serviço incompleto, toque duplicado e reconexão. Medir tempo para localizar/cobrar, erros, fila acumulada e reconciliação correta do gaveteiro.


## Estrutura visual proposta — tela de Cobranças do Caixa

### Hierarquia

A tela não deve parecer um dashboard financeiro nem uma cópia do OrderBoard. A tarefa é **encontrar a conta e cobrar**. A informação aparece progressivamente: fila enxuta → checkout focado → confirmação.

### Fila de cobranças

No topo: título **Cobranças**, contador de contas aguardando, busca por mesa/comanda/cliente e filtro secundário para histórico. Evitar gráficos, totais de vendas e indicadores da gaveta aqui; esses pertencem à tela Caixa/Relatórios.

No desktop, usar lista/tabela compacta e ordenada por antiguidade:

| Mesa/comanda | Cliente/atendente | Espera | Total devido | Ação |
|---|---|---:|---:|---|
| Mesa 12 · #184 | Evandro · Ana | 8 min | R$ 86,00 | **Cobrar** |

No mobile, cartões em coluna única com a mesma hierarquia: mesa/comanda grande, cliente/atendente, total, espera/status e botão **Cobrar** em área de toque confortável. A lista e o checkout não devem dividir a tela estreita: selecionar uma cobrança abre checkout em tela própria, com retorno preservando busca e posição da lista.

Exibir somente dados que ajudam a localizar/cobrar: mesa/rótulo, nome necessário à identificação, atendente, tempo e total; endereço, telefone, notas privadas e dados da cozinha não pertencem à lista. Se uma conta estiver bloqueada por itens não entregues, explicar o motivo em vez de apresentar um CTA inoperante.

### Checkout focalizado

Topo com voltar, mesa/comanda e cliente; **total devido** em destaque; resumo de itens acessível; métodos grandes e rotulados; campos que mudam conforme o método; “Dividir conta” como ação secundária. A barra inferior fixa deve mostrar o saldo e um único CTA primário.

- Dinheiro: “Valor recebido”, atalho “Exato”, troco calculado e aviso de gaveta fechada.
- Cartão: confirmar somente depois da confirmação do terminal/integração.
- Pix: mostrar “Aguardando confirmação”; não oferecer fechamento enquanto a liquidação não tiver sido confirmada.
- Sucesso: mostrar total, método(s), troco e se a mesa foi liberada. Se outro perfil ainda precisar fechar, dizer isso claramente.

No Caixa, manter gaveta como foco e apenas um atalho como **“Ir para cobranças · 6”**; não embutir a fila nos cards de sangria, suprimento ou sessão.

## Evolução futura — divisão por igual ou por item (fora desta fase)

As regras abaixo são uma visão de evolução futura, não requisitos deste ciclo. Para a nova tela de cobranças, não implementar rateio por participante/item, sessão de split ou pagamento parcial incremental; nesta fase usar somente os métodos de pagamento já suportados e a validação atual do total completo da comanda.

### Dividir igualmente

O caixa informa N participantes; o sistema cria parcelas exatas em centavos. Para total T em centavos: `base = floor(T/N)` e `resto = T mod N`; as primeiras `resto` parcelas recebem um centavo adicional. Ex.: R$ 127,00 por 3 = R$ 42,34 + R$ 42,33 + R$ 42,33. Participantes podem usar meios diferentes. Troco é calculado por participante e não diminui a parcela devida.

### Dividir por itens

Criar “Pessoa 1…N”; atribuir quantidades dos itens ativos a cada uma; exibir “Não atribuído” até completar o rateio. Não dividir uma unidade indivisível sem ação explícita “Dividir este item”. Itens compartilhados são repartidos em valores de centavos cuja soma corresponde exatamente à linha original; permanecem uma unidade na comanda/cozinha. Taxa de entrega/encargos exigem política visível (igual ou proporcional), sem rateio oculto.

Bloquear conclusão se houver quantidade/valor sem atribuição ou se a soma não fechar. Se uma linha mudar antes da confirmação, sinalizar e recalcular apenas a alocação afetada; nunca alterar silenciosamente valores já pagos.

### Limite atual e fases

O `PaymentModal.jsx` atual divide igualmente em N linhas, mas usa um único método selecionado para todas. O backend do `PUT /orders/:id/payments` exige que o lote some o total completo; não aceita uma parcela isolada agora e outra depois. O helper existente pode continuar sem alterações quando o `PaymentModal` for reutilizado; sua operação ainda gera todas as linhas no mesmo lote e exige o total completo. Não ampliar para identificar participantes nesta fase.

Pagamentos individuais em momentos diferentes exigem um split persistido e uma API de pagamento incremental. Não simular isso na UI usando o contrato atual. Linhas confirmadas são imutáveis; Pix pendente não reduz o pago confirmado; a comanda só fecha com todos os valores confirmados e itens servidos/cancelados.

### Matriz de alterações de backend e acesso (resumo)

Criar `GET /cashier/collections` e `GET /cashier/collections/:orderId` para cashier/manager, com DTO mínimo e escopo de tenant. Os GETs genéricos atuais de pedidos/mesa não fazem `requireRole`; restringir por consumidor legítimo (preservando KDS em `GET /orders` para kitchen) em vez de expor toda a ficha ao caixa.

Após definição da política operacional, permitir cashier/manager somente no registro/confirmação de linhas manuais e no fechamento (`PUT /orders/:id/payments`, `PATCH /orders/:id/payments/:paymentId`, `PATCH /orders/:id/close`). Manter caixa fora de abrir comanda, lançar/remover item, mudar estado da cozinha, cancelar comanda e estornar. As rotas de gateway já têm guards de caixa em parte do fluxo; não confundir gateway `payment` com ledger local `order_payment`.

Testar roles autorizados/negados, tenant, gaveta aberta para dinheiro, Pix pendente, total exato, idempotência, eventos realtime minimizados e fechamento com pendências. Não dar ao caixa acesso ao room `kitchen-display`; para atualização ao vivo, usar sala própria `cashier:collections` ou refetch explícito.

## Decisão de escopo — rateio fora desta fase

Não criar tabelas de split/participantes/alocações/tenders, migration ou pagamento incremental por pessoa nesta fase. A separação por item e o registro persistente de quem pagou cada parte ficam como evolução futura. O `PaymentModal` existente pode ser reutilizado sem expandir seu comportamento atual; seu rateio igual (se mantido na tela do caixa) continua sendo apenas o helper já existente que divide o total em linhas do mesmo método, sem identidade de participante ou pagamentos sequenciais.
