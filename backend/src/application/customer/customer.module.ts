/**
 * Módulo de clientes — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { CustomerDependencies } from "./ports/customer-dependencies.js";
import { SearchCustomersUseCase } from "./usecases/search-customers.usecase.js";
import { ListCustomersUseCase } from "./usecases/list-customers.usecase.js";
import { GetCustomerDetailUseCase } from "./usecases/get-customer-detail.usecase.js";
import { CreateCustomerUseCase } from "./usecases/create-customer.usecase.js";
import { UpdateCustomerUseCase } from "./usecases/update-customer.usecase.js";
import { SaveCustomerPhotoUseCase } from "./usecases/save-customer-photo.usecase.js";
import { ClearCustomerPhotoUseCase } from "./usecases/clear-customer-photo.usecase.js";
import { ListCustomerOrdersUseCase } from "./usecases/list-customer-orders.usecase.js";
import { CustomerSummaryUseCase } from "./usecases/customer-summary.usecase.js";

export class CustomerModule {
  public readonly searchCustomers: SearchCustomersUseCase;
  public readonly listCustomers: ListCustomersUseCase;
  public readonly getCustomerDetail: GetCustomerDetailUseCase;
  public readonly createCustomer: CreateCustomerUseCase;
  public readonly updateCustomer: UpdateCustomerUseCase;
  public readonly saveCustomerPhoto: SaveCustomerPhotoUseCase;
  public readonly clearCustomerPhoto: ClearCustomerPhotoUseCase;
  public readonly listCustomerOrders: ListCustomerOrdersUseCase;
  public readonly customerSummary: CustomerSummaryUseCase;

  constructor(deps: CustomerDependencies) {
    this.searchCustomers = new SearchCustomersUseCase(deps);
    this.listCustomers = new ListCustomersUseCase(deps);
    this.getCustomerDetail = new GetCustomerDetailUseCase(deps);
    this.createCustomer = new CreateCustomerUseCase(deps);
    this.updateCustomer = new UpdateCustomerUseCase(deps);
    this.saveCustomerPhoto = new SaveCustomerPhotoUseCase(deps);
    this.clearCustomerPhoto = new ClearCustomerPhotoUseCase(deps);
    this.listCustomerOrders = new ListCustomerOrdersUseCase(deps);
    this.customerSummary = new CustomerSummaryUseCase(deps);
  }
}
