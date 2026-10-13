/**
 * Clientes — ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class) em `usecases/*.usecase.ts`, com as dependências em
 * `ports/customer-dependencies.ts`, os helpers em
 * `shared/customer-helpers.ts` e o facade `CustomerModule` em
 * `customer.module.ts`.
 *
 * Este arquivo mantém a factory `createCustomerUsecases` com os NOMES LEGADOS
 * (`searchCustomersUsecase`, ...) para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `CustomerModule` e `.listCustomers.execute(...)`.
 *
 * Módulo puro: nenhuma importação de infra/Drizzle. Persistência via
 * `session.customers`/`session.customerAddresses`/`session.orders` na janela
 * `uow.run`, audit via `session.audit` (MESMA transação da escrita de domínio)
 * e arquivos via port `FileStorage`.
 *
 * Semântica preservada do módulo original (ver o header do arquivo original
 * no histórico): busca leve do balcão, listagem com contagem de endereços em
 * lote, detalhe com comandas abertas sem N+1 (doc 12), unicidade de
 * email/CPF com 400, foto com nome gerado pelo app, histórico paginado com
 * `NULLS LAST` e série de consumo com a MESMA régua de venda da visão geral.
 */
import { CustomerModule } from "./customer.module.js";
import type { CustomerDependencies } from "./ports/customer-dependencies.js";
import type { ListCustomersInput } from "./usecases/list-customers.usecase.js";
import type { CreateCustomerInput } from "./usecases/create-customer.usecase.js";
import type { UpdateCustomerInput } from "./usecases/update-customer.usecase.js";
import type { SaveCustomerPhotoInput } from "./usecases/save-customer-photo.usecase.js";
import type { ListCustomerOrdersInput } from "./usecases/list-customer-orders.usecase.js";
import type { CustomerSummaryInput } from "./usecases/customer-summary.usecase.js";

export { CustomerModule };
export type { CustomerDependencies };
export type { CustomerUsecasesDeps } from "./ports/customer-dependencies.js";
export { SearchCustomersUseCase } from "./usecases/search-customers.usecase.js";
export {
  ListCustomersUseCase,
  type ListCustomersInput,
} from "./usecases/list-customers.usecase.js";
export { GetCustomerDetailUseCase } from "./usecases/get-customer-detail.usecase.js";
export {
  CreateCustomerUseCase,
  type CreateCustomerInput,
} from "./usecases/create-customer.usecase.js";
export {
  UpdateCustomerUseCase,
  type UpdateCustomerInput,
} from "./usecases/update-customer.usecase.js";
export {
  SaveCustomerPhotoUseCase,
  type SaveCustomerPhotoInput,
} from "./usecases/save-customer-photo.usecase.js";
export { ClearCustomerPhotoUseCase } from "./usecases/clear-customer-photo.usecase.js";
export {
  ListCustomerOrdersUseCase,
  type ListCustomerOrdersInput,
} from "./usecases/list-customer-orders.usecase.js";
export {
  CustomerSummaryUseCase,
  type CustomerSummaryInput,
} from "./usecases/customer-summary.usecase.js";

export function createCustomerUsecases(deps: CustomerDependencies) {
  const module = new CustomerModule(deps);
  return {
    /** Busca leve do garçom (abrir comanda com cliente). */
    searchCustomersUsecase: (search?: string) => module.searchCustomers.execute(search),
    listCustomersUsecase: (input: ListCustomersInput) => module.listCustomers.execute(input),
    getCustomerDetailUsecase: (id: string) => module.getCustomerDetail.execute(id),
    createCustomerUsecase: (input: CreateCustomerInput, actorId: string) =>
      module.createCustomer.execute(input, actorId),
    updateCustomerUsecase: (id: string, input: UpdateCustomerInput, actorId: string) =>
      module.updateCustomer.execute(id, input, actorId),
    saveCustomerPhotoUsecase: (id: string, input: SaveCustomerPhotoInput, actorId: string) =>
      module.saveCustomerPhoto.execute(id, input, actorId),
    clearCustomerPhotoUsecase: (id: string, actorId: string) =>
      module.clearCustomerPhoto.execute(id, actorId),
    listCustomerOrdersUsecase: (customerId: string, input: ListCustomerOrdersInput) =>
      module.listCustomerOrders.execute(customerId, input),
    customerSummaryUsecase: (customerId: string, input: CustomerSummaryInput) =>
      module.customerSummary.execute(customerId, input),
  };
}

export type CustomerUsecases = ReturnType<typeof createCustomerUsecases>;
