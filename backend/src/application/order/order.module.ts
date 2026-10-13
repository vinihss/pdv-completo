/**
 * Módulo de pedidos — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências
 * (injetado via construtor) e expõe as instâncias como propriedades
 * readonly. É o que o composition root (ou um framework de DI) instancia.
 *
 * NOTA sobre async: dentro de `uow.run` o `TenantSession` é sempre Promise
 * (driver node-postgres) — todo acesso dentro da transação é `await`, e o
 * `throw` continua sendo o mecanismo de rollback (ver barrel
 * `order.usecases.ts`).
 */
import type { OrderDependencies } from "./ports/order-dependencies.js";
import { OpenOrderUseCase } from "./lifecycle/open-order.usecase.js";
import { CloseOrderUseCase } from "./lifecycle/close-order.usecase.js";
import { CancelOrderUseCase } from "./lifecycle/cancel-order.usecase.js";
import { AddItemsUseCase } from "./item/add-items.usecase.js";
import { UpdateItemStatusUseCase } from "./item/update-item-status.usecase.js";
import { DeleteItemUseCase } from "./item/delete-item.usecase.js";
import { SetOrderPaymentsUseCase } from "./payment/set-order-payments.usecase.js";
import { ConfirmOrderPaymentUseCase } from "./payment/confirm-order-payment.usecase.js";
import { DeleteOrderPaymentUseCase } from "./payment/delete-order-payment.usecase.js";
import { RegisterPaymentUseCase } from "./payment/register-payment.usecase.js";
import { GetOrderUseCase } from "./query/get-order.usecase.js";
import { ListOrdersUseCase } from "./query/list-orders.usecase.js";
import { ListTablesUseCase } from "./query/list-tables.usecase.js";

export class OrderModule {
  // lifecycle: abrir/fechar/cancelar
  public readonly openOrder: OpenOrderUseCase;
  public readonly closeOrder: CloseOrderUseCase;
  public readonly cancelOrder: CancelOrderUseCase;
  // item: lançar/atualizar/remover
  public readonly addItems: AddItemsUseCase;
  public readonly updateItemStatus: UpdateItemStatusUseCase;
  public readonly deleteItem: DeleteItemUseCase;
  // payment: fracionado + legado
  public readonly setOrderPayments: SetOrderPaymentsUseCase;
  public readonly confirmOrderPayment: ConfirmOrderPaymentUseCase;
  public readonly deleteOrderPayment: DeleteOrderPaymentUseCase;
  public readonly registerPayment: RegisterPaymentUseCase;
  // query: leitura
  public readonly getOrder: GetOrderUseCase;
  public readonly listOrders: ListOrdersUseCase;
  public readonly listTables: ListTablesUseCase;

  constructor(deps: OrderDependencies) {
    this.openOrder = new OpenOrderUseCase(deps);
    this.closeOrder = new CloseOrderUseCase(deps);
    this.cancelOrder = new CancelOrderUseCase(deps);
    this.addItems = new AddItemsUseCase(deps);
    this.updateItemStatus = new UpdateItemStatusUseCase(deps);
    this.deleteItem = new DeleteItemUseCase(deps);
    this.setOrderPayments = new SetOrderPaymentsUseCase(deps);
    this.confirmOrderPayment = new ConfirmOrderPaymentUseCase(deps);
    this.deleteOrderPayment = new DeleteOrderPaymentUseCase(deps);
    this.registerPayment = new RegisterPaymentUseCase(deps);
    this.getOrder = new GetOrderUseCase(deps);
    this.listOrders = new ListOrdersUseCase(deps);
    this.listTables = new ListTablesUseCase(deps);
  }
}
