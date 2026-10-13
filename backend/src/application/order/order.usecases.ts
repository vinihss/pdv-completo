// Hub de pedidos — ONDA 2 da refatoração arquitetural. Ponto de entrada de
// COMPATIBILIDADE.
//
// A implementação foi decomposta em um Use Case por operação (Command Pattern /
// Single Use Case Class), agrupado por subdomínio:
//
//   - `lifecycle/` — abrir / fechar / cancelar a comanda;
//   - `item/`      — lançar / atualizar status / remover itens;
//   - `payment/`   — pagamento fracionado (PUT, confirmar, remover) + legado;
//   - `query/`     — detalhe, lista de comandas e mesas;
//   - `ports/order-dependencies.ts` — deps injetadas por construtor;
//   - `shared/`    — serialização e total (leitura compartilhada);
//   - `payment/payment-lines.ts`    — plano/upsert das linhas de pagamento;
//   - `order.module.ts`            — facade `OrderModule`.
//
// Este arquivo mantém a factory `createOrderUsecases` com os NOMES LEGADOS
// (`openOrderUsecase`, `addItemsUsecase`, ...) para os consumidores que ainda
// instanciam via factory (a composition root `infra/composition
// /default-usecases.ts`, a rota `order.routes.ts` e o self-service via tipo
// `OrderUsecases`). Nada muda na assinatura observada de fora; internamente a
// factory só orquestra as classes do `OrderModule`. Para uso novo, prefira
// instanciar `OrderModule` e chamar `.openOrder.execute(...)`.
//
// O módulo continua uma camada PURA: nenhuma importação de
// infra/integrations/Drizzle. Toda persistência/efeito transacional passa pelos
// ports do `TenantSession` (Unit-of-Worker), e os efeitos pós-commit
// (impressão, cache de relatórios) chegam via deps injetadas. A composition
// root que liga adapters concretos é `src/infra/composition/default-usecases.ts`.
//
// NOTA IMPORTANTE sobre async (leia antes de tocar em qualquer transação):
// O banco oficial é Postgres, e o driver node-postgres é assíncrono de
// verdade. `uow.run(tenant, work)` entrega à `work` um `TenantSession` cujo
// repositório é SEMPRE uma Promise, então dentro da transação tudo é `await`:
//
//   await deps.uow.run(deps.tenant(), async (session) => {
//     const row = await session.orders.open({...});
//     await session.audit.record({...});
//   });
//
// Esquecer um `await` dentro da transação é o erro perigoso desta camada: o
// INSERT pode ser emitido depois do COMMIT e a escrita se perder
// silenciosamente, então todo acesso dentro do `session` precisa de `await`.
//
// O `throw` continua sendo o mecanismo de rollback (a transação aborta e o
// erro propaga), então os AppError de domínio seguem funcionando igual.
//
// APROXIMAÇÃO DE JANELA (documentada de propósito): leituras que hoje rodam
// "fora do tx" (pedido, settings, itens) rodam DENTRO do `uow.run` — uma única
// janela transacional por use case. Sob READ COMMITTED o resultado é o mesmo
// (snapshot por statement); o ganho é um caminho só para ler e escrever, sem
// meio-commit.
import { OrderModule } from "./order.module.js";
import type { OrderDependencies } from "./ports/order-dependencies.js";
import type { OpenOrderInput } from "./lifecycle/open-order.usecase.js";
import type { AddItemsInput } from "./item/add-items.usecase.js";
import type { UpdateItemStatusInput } from "./item/update-item-status.usecase.js";
import type { DeleteItemInput } from "./item/delete-item.usecase.js";
import type { SetOrderPaymentsInput } from "./payment/set-order-payments.usecase.js";
import type { ConfirmOrderPaymentInput } from "./payment/confirm-order-payment.usecase.js";
import type { DeleteOrderPaymentInput } from "./payment/delete-order-payment.usecase.js";
import type { RegisterPaymentInput } from "./payment/register-payment.usecase.js";
import type { CloseOrderInput } from "./lifecycle/close-order.usecase.js";
import type { CancelOrderInput } from "./lifecycle/cancel-order.usecase.js";
import type { ListOrdersInput } from "./query/list-orders.usecase.js";

export { OrderModule };
export type { OrderDependencies };
export type { OrderUsecasesDeps } from "./ports/order-dependencies.js";
export { OpenOrderUseCase, type OpenOrderInput } from "./lifecycle/open-order.usecase.js";
export { CloseOrderUseCase, type CloseOrderInput } from "./lifecycle/close-order.usecase.js";
export { CancelOrderUseCase, type CancelOrderInput } from "./lifecycle/cancel-order.usecase.js";
export { AddItemsUseCase, type AddItemsInput } from "./item/add-items.usecase.js";
export {
  UpdateItemStatusUseCase,
  type UpdateItemStatusInput,
} from "./item/update-item-status.usecase.js";
export { DeleteItemUseCase, type DeleteItemInput } from "./item/delete-item.usecase.js";
export {
  SetOrderPaymentsUseCase,
  type SetOrderPaymentsInput,
} from "./payment/set-order-payments.usecase.js";
export {
  ConfirmOrderPaymentUseCase,
  type ConfirmOrderPaymentInput,
} from "./payment/confirm-order-payment.usecase.js";
export {
  DeleteOrderPaymentUseCase,
  type DeleteOrderPaymentInput,
} from "./payment/delete-order-payment.usecase.js";
export {
  RegisterPaymentUseCase,
  type RegisterPaymentInput,
} from "./payment/register-payment.usecase.js";
export { GetOrderUseCase } from "./query/get-order.usecase.js";
export { ListOrdersUseCase, type ListOrdersInput } from "./query/list-orders.usecase.js";
export { ListTablesUseCase } from "./query/list-tables.usecase.js";

/**
 * As 13 use cases do hub de pedidos, com as MESMAS assinaturas de input das
 * funções avulsas antigas (a única diferença era o `deps` primeiro, agora
 * injetado no construtor de cada classe). Os nomes legados
 * (`openOrderUsecase(...)` etc.) são re-exportados por
 * `infra/composition/default-usecases.ts` para os consumidores não migrados.
 */
export function createOrderUsecases(deps: OrderDependencies) {
  const module = new OrderModule(deps);
  return {
    openOrderUsecase: (input: OpenOrderInput) => module.openOrder.execute(input),
    addItemsUsecase: (input: AddItemsInput) => module.addItems.execute(input),
    updateItemStatusUsecase: (input: UpdateItemStatusInput) => module.updateItemStatus.execute(input),
    deleteItemUsecase: (input: DeleteItemInput) => module.deleteItem.execute(input),
    setOrderPaymentsUsecase: (input: SetOrderPaymentsInput) => module.setOrderPayments.execute(input),
    confirmOrderPaymentUsecase: (input: ConfirmOrderPaymentInput) =>
      module.confirmOrderPayment.execute(input),
    deleteOrderPaymentUsecase: (input: DeleteOrderPaymentInput) =>
      module.deleteOrderPayment.execute(input),
    registerPaymentUsecase: (input: RegisterPaymentInput) => module.registerPayment.execute(input),
    closeOrderUsecase: (input: CloseOrderInput) => module.closeOrder.execute(input),
    cancelOrderUsecase: (input: CancelOrderInput) => module.cancelOrder.execute(input),
    getOrderUsecase: (orderId: string) => module.getOrder.execute(orderId),
    listOrdersUsecase: (input: ListOrdersInput) => module.listOrders.execute(input),
    listTablesUsecase: () => module.listTables.execute(),
  };
}

export type OrderUsecases = ReturnType<typeof createOrderUsecases>;
