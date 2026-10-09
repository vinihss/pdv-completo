# Plano de implementação — Comandas do garçom (primeiro ciclo)

**Base:** [`estudo-usabilidade-comandas-garcom.md`](estudo-usabilidade-comandas-garcom.md)
**Fase:** Etapa 1 do estudo — "corrigir fricção e risco de erro" + itens baratos da Etapa 2.
**Status:** em execução; nada aqui é comportamento implementado até o código e os testes fecharem.
**Data:** 9 de outubro de 2026

## Escopo deste ciclo (frontend, comanda do garçom)

Sem mudança de contrato HTTP, sem migration, sem backend novo. Reutiliza os
endpoints e o `PaymentModal` atuais.

1. **P0 — Permanecer no detalhe após lançar itens.** Confirmar o lote não
   devolve o garçom à lista; a mesma comanda recarrega e ganha feedback
   ("N itens enviados para a cozinha").
2. **P0 — Pagamento confirmado fecha em um passo.** O CTA "Registrar pagamento e
   fechar" registra o pagamento e, com tudo confirmado, fecha a comanda sem
   exigir um segundo toque. Pix pendente mantém a comanda aberta e explica o
   motivo. "Ajustar" continua permitindo só reabrir o pagamento.
3. **P1 — Entrega por ação rotulada.** Botão explícito "Marcar como entregue"
   no item pronto (ou `ordered` sem cozinha); tocar na linha/nome não altera
   estado.
4. **P1 — Resumo do trabalho a fazer.** Contagens "N prontos · M em preparo" no
   cartão da lista e no detalhe; pendências explicadas no fechamento.
5. **Carrinho com `− / +` e envio explícito.** Revisão com controle de
   quantidade e botão "Enviar N itens para a cozinha" (ou "Confirmar N itens").
6. **Feedback de catálogo.** Estados de carregando/erro no lançamento de itens
   (hoje a falha de catálogo parece catálogo vazio).
7. **Ajustes móveis baratos.** Sinal único para comanda >24h; rótulos/tooltips
   nos ícones de cabeçalho; FAB "Nova comanda" sem cobrir o último cartão;
   legenda de mesa livre/ocupada sem depender só de cor.

## Fora deste ciclo

- **Cobranças do Caixa** (tela própria, endpoints segregados, permissões,
  realtime em `cashier:collections`) — já tem plano dedicado em
  [`plano-implementacao-cobrancas-caixa.md`](plano-implementacao-cobrancas-caixa.md);
  é mudança transversal com backend e precisa das decisões de produto.
- **Rateio por participante/item, pagamento parcial incremental** — fora de
  escopo por decisão explícita do estudo.
- **Mapa do salão / setores** e **continuar comanda existente pela mesa** —
  Etapa 2/3 do estudo; dependem de decisão de operação.
- **Backend/DB** — nenhuma alteração.

## Delegação

| Agente | Arquivos (escopo) | Entrega |
|---|---|---|
| A — detalhe/fechamento | `widgets/order-board/OrderBoard.jsx`, `OrderDetailScreen.jsx`, `OrderDetailScreen.test.jsx` | itens 1, 2, 3, 4 (detalhe) |
| B — lançamento/carrinho | `features/orders/AddItemScreen.jsx`, `ReviewCartModal.jsx` + testes | itens 5, 6 |
| C — lista/nova comanda | `widgets/order-board/OrderListScreen.jsx`, `features/orders/NewOrderModal.jsx` + testes | itens 4 (lista), 7 |

Interface fixada: `AddItemScreen` chama `onConfirmed(totalQuantity)`; o detalhe
repassa para `onItemsConfirmed(count)`; `OrderBoard` mantém o detalhe aberto.
Helper de contagem em `entities/order/model/order.js` (`orderItemCounts`).

## Validação deste ciclo

- Unitários de frontend apenas (sem integração, sem backend): `npx vitest run`
  nos arquivos tocados + `fsd-boundaries`.
- `npx oxlint` nos arquivos tocados.
- Suíte completa, smoke por perfil e validação em dispositivo ficam para a
  integração, porque há outros agentes na máquina.
