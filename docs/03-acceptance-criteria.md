# Critérios de Aceite — Sistema de PDV (Restaurante/Pub)

Formato: **Dado / Quando / Então** (Gherkin simplificado), um critério por comportamento testável. Cada bloco cobre uma funcionalidade descrita em `01-backend-spec.md` e `02-frontend-spec.md` — as referências entre parênteses apontam pra seção detalhada, caso o critério pareça incompleto sozinho.

Convenção: critérios marcados com ⚠️ cobrem comportamento que já gerou ambiguidade ou inconsistência ao longo deste projeto (ver `00-overview.md`) — merecem atenção redobrada na hora de testar.

## 1. Login (frontend §3, backend §7.1, §11)

- **Dado** um usuário ativo com PIN correto, **quando** ele digita o PIN, **então** recebe token válido e é redirecionado pra tela inicial do seu `role`.
- **Dado** um PIN incorreto, **quando** o usuário tenta logar, **então** vê a mensagem genérica "PIN incorreto. Tente novamente." — nunca uma mensagem diferente por já ter errado várias vezes.
- ⚠️ **Dado** uma conta bloqueada por excesso de tentativas, **quando** o usuário tenta logar mesmo com o PIN certo, **então** a mensagem de erro é **idêntica** à de PIN incorreto — o sistema nunca revela que a conta está bloqueada (§11).
- **Dado** mais de 10 tentativas de login pelo mesmo IP em 1 minuto, **quando** uma nova tentativa chega, **então** a API responde `429 too_many_attempts`, independente de qual conta está sendo testada.
- **Dado** um usuário logado, **quando** ele toca em "Trocar usuário", **então** a sessão é encerrada localmente e a tela de seleção de usuário aparece, sem precisar de confirmação extra.
- **Dado** `store_settings.kitchen_enabled = false`, **quando** a tela de seleção de usuário carrega, **então** nenhum usuário com role `kitchen` aparece na lista — a conta continua existindo, só não é oferecida pra login.

## 2. Abertura de comanda (frontend §4.2, backend §7.2)

- **Dado** `store_settings.uses_tables = true`, **quando** o garçom abre "Nova comanda", **então** o toggle Mesa/Cliente aparece, com Mesa como opção disponível.
- **Dado** `store_settings.uses_tables = false`, **quando** o garçom abre "Nova comanda", **então** o toggle não aparece — o formulário vai direto pro modo Cliente, sem seleção de mesa em lugar nenhum da UI (incluindo o filtro da lista, §4.1).
- **Dado** o formulário de abertura, **quando** o garçom confirma sem preencher mesa, cliente ou rótulo, **então** a API responde `400 identification_required` e a UI impede o envio antes mesmo de chamar a API (validação no client).
- **Dado** uma mesa já ocupada (tem comanda `open` vinculada), **quando** ela aparece no grid de seleção, **então** não é selecionável como "livre" — só mesas sem comanda aberta aparecem como disponíveis.

## 3. Adicionar item — carrinho, revisão, confirmação em lote (frontend §4.4)

- **Dado** a tela de adicionar item, **quando** o garçom toca num produto sem variação, **então** ele entra no carrinho local imediatamente, com feedback visual (flash + badge de quantidade) — **nenhuma chamada à API acontece nesse momento**.
- **Dado** um produto com variações, **quando** o garçom toca nele, **então** um modal de seleção de opções abre antes de adicionar ao carrinho.
- **Dado** o carrinho com 1+ item, **quando** o garçom olha a tela, **então** a barra fixa no rodapé mostra a contagem e o total corretos, atualizados a cada toque.
- **Dado** a folha de revisão do carrinho aberta, **quando** o garçom altera a quantidade de uma linha pra zero (via stepper ou remoção), **então** a linha desaparece da revisão e do total, sem afetar as demais linhas.
- **Dado** a revisão do carrinho, **quando** o garçom toca "Confirmar adição", **então** todas as linhas são enviadas numa única chamada em lote (`POST /orders/:id/items`) com `correlationId` único, e só depois da resposta 201 a tela de sucesso aparece.
- ⚠️ **Dado** uma falha de rede logo após "Confirmar adição", **quando** o app tenta novamente automaticamente (retry) com o **mesmo** `correlationId`, **então** a API não duplica os itens — a idempotência (§10) garante que o retry é seguro.
- **Dado** a tela de sucesso após confirmar, **quando** ~1s se passa, **então** o app navega direto pra lista de comandas — **não** para a comanda que acabou de ser editada.

## 4. Remover item (frontend §4.3, backend §7.2)

- **Dado** um item com status `ordered` ou `ready`, **quando** o garçom toca no ícone de lixeira, **então** um modal de confirmação aparece antes de qualquer remoção — nunca é uma ação de um toque só.
- **Dado** um item com status `delivered`, **quando** o garçom olha a lista de itens, **então** o ícone de remover **não aparece** para esse item.
- ⚠️ **Dado** um item marcado `delivered` por outra sessão (ex: outro dispositivo do mesmo garçom) entre o carregamento da tela e o toque em remover, **quando** a remoção é enviada mesmo assim, **então** a API responde `409 item_already_delivered`, e a UI deve tratar esse erro (recarregar a comanda), não travar silenciosamente.
- **Dado** uma remoção confirmada, **quando** ela é concluída, **então** uma entrada `item_removed` aparece no log de auditoria da comanda (§13), visível na tela de log do garçom.

## 5. Fechar conta (frontend §4.5, backend §7.2, §9) ⚠️

- **Dado** uma comanda com todo item `delivered` e forma de pagamento já registrada, **quando** o garçom acessa a comanda, **então** o botão "Fechar conta" está habilitado.
- **Dado** uma comanda com ao menos 1 item que não é `delivered`, **quando** o garçom olha a tela, **então** o botão "Fechar conta" está desabilitado **e** um aviso lista os itens pendentes por nome (não só a contagem).
- **Dado** uma comanda sem nenhuma linha em `order_payment`, **quando** o garçom tenta fechar mesmo assim (ex: via chamada direta à API, contornando a UI), **então** a API responde `409 payment_not_registered`.
- **Dado** o garçom escolhe "Dinheiro" como forma de pagamento, **quando** ele toca na opção, **então** uma tela de confirmação explícita aparece antes de qualquer coisa ser gravada — **nenhuma forma de pagamento fecha a comanda no primeiro toque**, nem as não-Pix.
- **Dado** o fluxo Pix, **quando** o QR é exibido e o garçom toca "Confirmar recebimento", **então** essa ação conta como a confirmação obrigatória — não existe uma segunda tela de confirmação depois dela.
- **Dado** uma forma de pagamento desabilitada em `store_settings.enabled_payment_methods`, **quando** o garçom abre a tela de fechamento, **então** essa opção não aparece na lista de formas disponíveis.
- **Dado** a função de caixa do gerente, **quando** ele tenta fechar uma comanda com item pendente, **então** o mesmo bloqueio se aplica — o botão "Fechar" é substituído por um resumo dos itens pendentes, igual ao comportamento do garçom.

### 5.1 Pagamento fracionado e troco

- **Dado** uma comanda de R$ 37,00, **quando** o garçom registra dinheiro R$ 20,00 (recebido R$ 50,00) + cartão R$ 17,00, **então** ambos os pedaços ficam em `order_payment` com troco R$ 30,00 no dinheiro, e o botão "Fechar conta" habilita.
- **Dado** um preenchimento cuja soma não bate com o total (ex.: pedaços somam R$ 34,00 numa comanda de R$ 37,00), **quando** o garçom toca em registrar, **então** a modal bloqueia com "Falta R$ 3,00" **e** a API responde `409 invalid_payment_total` se chamada direto.
- **Dado** uma linha de dinheiro com `received < amount`, **quando** a soma total está correta, **então** o registro é bloqueado com "Faltam R$ X" na UI (`422 validation_failed` por API direta).
- **Dado** o atalho "Dividir igualmente entre 3", **quando** a conta é de R$ 40,00, **então** geram 3 pedaços (R$ 13,33 / R$ 13,33 / R$ 13,34), cuja soma é exatamente R$ 40,00.
- **Dado** uma comanda com pedaço Pix ainda não confirmado (`confirmed=false`), **quando** o garçom tenta fechar, **então** a API responde `409 payment_not_confirmed` e a UI reabre a modal de pagamento.
- **Dado** dinheiro R$ 40,00 (recebido R$ 100,00) + Pix R$ 34,00, **quando** o garçom confirma o QR do pedaço Pix, **então** a comanda fecha e `order_payment` registra os 2 pedaços (troco R$ 60,00 no dinheiro, pix confirmado).
- **Dado** o detalhe da comanda, **quando** há mais de uma forma de pagamento registrada, **então** a tela mostra o quebra-cabeça (cada forma, valor e troco) e permite ajustar enquanto a conta não fechou.

## 6. Configurações da loja (frontend §5, backend §7.3)

- **Dado** o gerente muda `uses_tables` de `true` para `false` em Configurações, **quando** ele salva, **então** a próxima vez que qualquer garçom abrir a tela de nova comanda, o toggle de Mesa já não aparece — sem precisar de reload do app inteiro, só da tela relevante.
- **Dado** o gerente desmarca "Pix" em formas de pagamento habilitadas, **quando** ele salva, **então** a opção some do fechamento de conta de todos os garçons a partir da próxima interação com a tela.
- **Dado** `merchant_name` ou `merchant_city` acima do limite de caracteres do padrão BR Code, **quando** o gerente tenta salvar, **então** a API responde `400 validation_failed` e a UI mostra o erro no campo específico, não um alerta genérico.

## 7. Categorias (frontend §5, backend §7.6)

- **Dado** uma categoria nova, **quando** o gerente digita o nome e confirma, **então** ela aparece na lista imediatamente, e também nas abas de seleção de produto do garçom (na próxima vez que ele abrir a tela de adicionar item).
- **Dado** uma categoria com produtos vinculados, **quando** o gerente tenta excluí-la, **então** o modal de confirmação mostra quantos produtos serão afetados — a exclusão **não é bloqueada**, só avisada.
- **Dado** a exclusão confirmada, **quando** ela é concluída, **então** os produtos que pertenciam a essa categoria passam a ter `category_id` nulo, e continuam existindo e podendo ser vendidos (aparecem em algum lugar acessível pro gerente reatribuir depois — decisão de onde exatamente é um ponto a refinar na implementação).
- **Dado** a lista de categorias, **quando** o gerente usa as setas de reordenar, **então** a ordem alterada reflete na ordem das abas do garçom, respeitando `display_order`.

## 8. Tela da cozinha (frontend §6)

- **Dado** um item recém-lançado numa comanda, **quando** o evento `order.item.created` chega via WebSocket, **então** ele aparece na zona "Em preparo" da cozinha sem precisar de reload manual.
- **Dado** um item na zona "Em preparo" há mais tempo que `store_settings.kitchen_prep_warn_min` (padrão 3 minutos), **quando** o cronômetro atualiza, **então** o cartão muda para a cor âmbar; passando de `kitchen_prep_urgent_min` (padrão 6 minutos), muda para vermelho com destaque pulsante.
- **Dado** um item na zona "Em preparo", **quando** o cozinheiro toca em qualquer parte do cartão, **então** o item muda para `ready` e se move pra zona "Prontos" — não existe sub-menu ou confirmação extra nesse toque.
- ⚠️ **Dado** um item na zona "Prontos", **quando** o tempo passa (mesmo além de `kitchen_pickup_urgent_min`, mesmo além de 1 hora), **então** ele **nunca** desaparece sozinho — só sai dali quando o garçom marca `delivered` no app dele. O destaque vermelho pulsante depois desse limiar é só visual, não remove o item.
- **Dado** o gerente altera `kitchen_prep_warn_min`/`kitchen_prep_urgent_min`/`kitchen_pickup_urgent_min` em Configurações, **quando** ele salva, **então** a tela da cozinha passa a usar os novos valores na próxima vez que buscar `store_settings` — sem precisar de deploy ou reinício do app.
- **Dado** o gerente tenta salvar `kitchenPrepUrgentMin` menor ou igual a `kitchenPrepWarnMin`, **quando** ele confirma, **então** a API responde `400 invalid_kitchen_thresholds` e a UI impede o salvamento com essa combinação.
- **Dado** o garçom marca um item como `delivered`, **quando** isso acontece, **então** o evento correspondente remove o item da zona "Prontos" da cozinha em tempo real, via WebSocket.

## 9. Concorrência e idempotência (backend §9, §10)

- **Dado** dois garçons abrindo a mesma comanda ao mesmo tempo, **quando** um marca um item como `ready` e o outro tenta marcar o **mesmo** item como `delivered` com a `version` antiga (já desatualizada), **então** a segunda chamada recebe `409 concurrency_conflict`, e o item não fica num estado inconsistente.
- **Dado** um `correlationId` já processado com sucesso, **quando** a mesma chamada chega de novo (retry de rede, duplo-toque), **então** a API devolve a **mesma resposta** da primeira vez, sem criar um registro duplicado.
- **Dado** dois garçons mexendo em **itens diferentes** da mesma comanda ao mesmo tempo, **quando** ambos salvam, **então** nenhum dos dois recebe conflito — o lock é por item, não pela comanda inteira (§9).

## 10. Log de auditoria (backend §13, frontend §4.4.1)

- **Dado** qualquer ação relevante (abrir comanda, adicionar item, remover item, marcar entregue, fechar comanda), **quando** ela é concluída com sucesso, **então** uma entrada correspondente aparece em `audit_log`, com `user_id`, `order_id` (quando aplicável) e `details` preenchidos.
- **Dado** a tela de log do garçom (ícone de histórico), **quando** ele abre, **então** vê as ações em ordem cronológica, mais recente primeiro, com timestamp legível.
- **Dado** uma ação que falhou (ex: tentativa de remover item já entregue, recusada com 409), **quando** isso acontece, **então** **não** deve gerar entrada de auditoria — o log registra o que aconteceu, não o que foi tentado e recusado (a menos que isso seja decidido como útil pra segurança; hoje a spec não prevê log de tentativas falhas).

## 11. Gerente com acesso total às comandas (frontend §5, backend §7.2)

- **Dado** o gerente na aba "Comandas", **quando** ele abre uma comanda de qualquer garçom, **então** ele vê e pode agir sobre ela exatamente como o garçom original — adicionar item, remover item, marcar entregue, fechar conta — sem nenhuma limitação de "só leitura".
- **Dado** uma comanda aberta pelo garçom Carlos, **quando** a gerente Roberto adiciona um item nela, **então** o item aparece pra Carlos normalmente na próxima vez que ele abrir aquela comanda — é a mesma comanda, o mesmo estado, não uma cópia.
- **Dado** o garçom ocupado e um cliente querendo pagar, **quando** o gerente abre a comanda direto (sem depender do garçom), **então** ele consegue fechar a conta com o mesmo fluxo de confirmação de pagamento — nenhuma etapa é pulada só por ser o gerente.

## 12. Cozinha condicional — `kitchen_enabled` (frontend §3, §4.3, §5, §6; backend §1, §4, §7.2)

- **Dado** `kitchen_enabled = true` (padrão), **quando** um item é lançado, **então** ele nasce `ordered` e só fica tocável pelo garçom pra `delivered` depois que a cozinha marcar `ready`.
- **Dado** `kitchen_enabled = false`, **quando** um item é lançado, **então** ele nasce `ordered` e já é tocável direto pelo garçom pra `delivered` — não existe etapa `ready` nesse modo.
- ⚠️ **Dado** `kitchen_enabled = false`, **quando** qualquer chamada tenta setar um item como `ready` mesmo assim (ex: cliente antigo em cache, chamada direta à API), **então** a API responde `400 invalid_transition` — `ready` não é uma transição válida nesse modo, para ninguém.
- **Dado** o gerente desativa "Usar tela da cozinha" em Configurações, **quando** ele salva, **então** os três campos de limiares de tempo da cozinha somem do formulário (não fazem sentido sem cozinha) e a validação de limiar inválido deixa de bloquear o salvamento.
- **Dado** `kitchen_enabled = false`, **quando** um usuário com role `kitchen` existe no cadastro, **então** ele não aparece na tela de seleção de login — mas continua existindo e volta a aparecer se o gerente reativar o recurso depois.

## 13. Relatório de vendas (frontend §5, backend §7.9)

- **Dado** a tela de Relatórios sem nenhum filtro aplicado, **quando** ela carrega, **então** mostra as comandas fechadas dos últimos 30 dias por padrão, não a base inteira.
- **Dado** um filtro de período (de/até), **quando** aplicado, **então** só entram no cálculo comandas com `closed_at` dentro do intervalo — comandas ainda abertas nunca aparecem no relatório, mesmo que tenham itens.
- **Dado** um filtro por produto, **quando** aplicado, **então** só aparecem comandas que contêm ao menos um item daquele produto — o valor mostrado continua sendo o total da comanda inteira, não só a fatia daquele produto.
- **Dado** o resumo (total vendido, ticket médio, número de comandas), **quando** um filtro é alterado, **então** os três números recalculam sobre o conjunto filtrado inteiro, não sobre uma página — paginar (se existir) não pode mudar o total exibido.
- **Dado** o detalhamento por forma de pagamento, **quando** ele é somado, **então** bate exatamente com o total vendido do resumo — não pode haver comanda contada em um e não no outro. Comanda paga em duas formas (ex.: dinheiro + Pix) **não** pode somar o total duas vezes nos dois métodos; cada pedaço entra uma vez na sua forma.
- **Dado** uma comanda com pedaço de dinheiro e troco, **quando** o relatório agrega o dia, **então** `summary.changeTotal` soma os trocos dados e o fraturamento por forma soma os `amount` de cada pedaço (o troco não reduz a receita por forma — ele é informação à parte).
- ⚠️ **Dado** um produto que teve seu preço alterado depois de vendido, **quando** o relatório calcula o total de uma comanda antiga, **então** usa o `unit_price` gravado no momento do lançamento (snapshot), não o preço atual do produto — histórico de vendas não pode mudar retroativamente por causa de um reajuste de preço.

## Como usar este documento

Cada bloco acima deve virar um ou mais casos de teste automatizado (integração, no mínimo, pros fluxos de `order`/`item`; unitário pros usecases de domínio). Os itens marcados ⚠️ são os candidatos naturais a teste automatizado prioritário, por já terem histórico de ambiguidade neste projeto — vale garantir que eles tenham cobertura antes de qualquer coisa mais "óbvia" da lista.
