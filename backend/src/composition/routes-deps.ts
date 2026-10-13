/**
 * Tipos dos containers de dependências das rotas — ONDA 7.
 *
 * Cada namespace é derivado das factories de use cases, então os tipos
 * acompanham a assinatura real de cada use case automaticamente. As rotas
 * importam o namespace do qual precisam (`RoutesDeps["order"]`, por exemplo)
 * e destruturam as funções do parâmetro `deps`. Nenhum import de adapters
 * sobrevive nas rotas.
 */
import {
  createOrderUsecases,
} from "../application/order/order.usecases.js";
import { createAlertUsecases } from "../application/alert/alert.usecases.js";
import { createAuditLogUsecases } from "../application/audit-log/audit-log.usecases.js";
import { createLoginUsecase } from "../application/auth/login.usecase.js";
import { createCashFlowUsecases } from "../application/cash-flow/cash-flow.usecases.js";
import { createProductUsecases } from "../application/product/product.usecases.js";
import { createCategoryUsecases } from "../application/category/category.usecases.js";
import { createKitchenGroupUsecases } from "../application/kitchen-group/kitchen-group.usecases.js";
import { createMenuUsecases } from "../application/self-service/menu.usecases.js";
import { createCartUsecases } from "../application/self-service/cart.usecases.js";
import {
  createCustomerAddressUsecases,
} from "../application/self-service/customer-address.usecases.js";
import { createSelfServiceCancelUsecases } from "../application/self-service/cancel-order.usecase.js";
import { createDeliveryUsecases } from "../application/delivery/calcular-entrega.usecase.js";
import { createOrderIntakeUsecases } from "../application/self-service/order-intake.usecase.js";
import { createSelfServiceDeliveryUsecases } from "../application/self-service/delivery.usecases.js";
import { createManagerDeliveryStatusUsecases } from "../application/self-service/manager-delivery-status.usecase.js";
import { createUserUsecases } from "../application/user/user.usecases.js";
import { createCustomerUsecases } from "../application/customer/customer.usecases.js";
import {
  createStoreSettingsUsecases,
} from "../application/store-settings/store-settings.usecases.js";
import {
  createReportUsecases,
  createOverviewReportUsecases,
  createDeliveriesReportUsecases,
} from "../application/report/report.usecases.js";
import { createPurchaseUsecases } from "../application/purchase/purchase.usecases.js";
import { createRefundUsecases } from "../application/refund/refund.usecases.js";
import { createStockUsecases } from "../application/stock/stock.usecases.js";
import { createProvisioningUsecases } from "../application/provisioning/provisioning.usecases.js";
import { createProvisioningEmailUsecases } from "../application/provisioning/provisioning-email.usecase.js";
import { createTenantUsecases } from "../application/tenant/resolve-tenant.usecase.js";

// ---------------------------------------------------------------------------
// Namespaces de dependências por domínio
// ---------------------------------------------------------------------------

export type OrderRoutesDeps = ReturnType<typeof createOrderUsecases>;
export type AlertRoutesDeps = ReturnType<typeof createAlertUsecases>;
export type AuditLogRoutesDeps = ReturnType<typeof createAuditLogUsecases>;

// auth = PIN login + perfil/listagem de usuários (sem o CRUD completo)
export type AuthRoutesDeps = ReturnType<typeof createLoginUsecase> & {
  listActiveUsersUsecase: ReturnType<typeof createUserUsecases>["listActiveUsersUsecase"];
  getOwnProfileUsecase: ReturnType<typeof createUserUsecases>["getOwnProfileUsecase"];
  updateOwnProfileUsecase: ReturnType<typeof createUserUsecases>["updateOwnProfileUsecase"];
  saveUserPhotoUsecase: ReturnType<typeof createUserUsecases>["saveUserPhotoUsecase"];
  clearUserPhotoUsecase: ReturnType<typeof createUserUsecases>["clearUserPhotoUsecase"];
};

export type CashFlowRoutesDeps = ReturnType<typeof createCashFlowUsecases>;

export type CatalogRoutesDeps =
  & ReturnType<typeof createProductUsecases>
  & ReturnType<typeof createCategoryUsecases>
  & ReturnType<typeof createKitchenGroupUsecases>
  & ReturnType<typeof createMenuUsecases>;

// self-service = carrinho, cliente/endereço, checkout público,
// cancelamento, entrega (courier + manager) e geocoding
export type SelfServiceRoutesDeps =
  & ReturnType<typeof createDeliveryUsecases>
  & ReturnType<typeof createMenuUsecases>
  & ReturnType<typeof createCartUsecases>
  & ReturnType<typeof createCustomerAddressUsecases>
  & ReturnType<typeof createSelfServiceCancelUsecases>
  & ReturnType<typeof createOrderIntakeUsecases>
  & ReturnType<typeof createSelfServiceDeliveryUsecases>
  & ReturnType<typeof createManagerDeliveryStatusUsecases>;

// customer = cliente do balcão + entregas atribuídas ao courier/gerente
export type CustomerRoutesDeps =
  & ReturnType<typeof createCustomerUsecases>
  & ReturnType<typeof createCustomerAddressUsecases>
  & ReturnType<typeof createSelfServiceDeliveryUsecases>
  & ReturnType<typeof createManagerDeliveryStatusUsecases>;

export type UserRoutesDeps = ReturnType<typeof createUserUsecases>;

// store-settings = configurações + geocode de restaurante
export type StoreSettingsRoutesDeps =
  & ReturnType<typeof createStoreSettingsUsecases>
  & Pick<ReturnType<typeof createDeliveryUsecases>, "geocodeRestaurantUsecase">;

export type ReportsRoutesDeps =
  & ReturnType<typeof createReportUsecases>
  & ReturnType<typeof createOverviewReportUsecases>
  & ReturnType<typeof createDeliveriesReportUsecases>;

export type FinanceRoutesDeps = ReturnType<typeof createPurchaseUsecases> &
  ReturnType<typeof createRefundUsecases>;

export type StockRoutesDeps = ReturnType<typeof createStockUsecases> &
  Pick<ReturnType<typeof createPurchaseUsecases>, "inventoryValuationUsecase">;

export type ProvisioningRoutesDeps = ReturnType<typeof createProvisioningUsecases> &
  ReturnType<typeof createProvisioningEmailUsecases>;

export type TenantRoutesDeps = ReturnType<typeof createTenantUsecases>;

// container completo = tudo o que o router injeta nas rotas
export type RoutesDeps = {
  order: OrderRoutesDeps;
  alert: AlertRoutesDeps;
  auditLog: AuditLogRoutesDeps;
  auth: AuthRoutesDeps;
  cashFlow: CashFlowRoutesDeps;
  catalog: CatalogRoutesDeps;
  selfService: SelfServiceRoutesDeps;
  customer: CustomerRoutesDeps;
  user: UserRoutesDeps;
  storeSettings: StoreSettingsRoutesDeps;
  reports: ReportsRoutesDeps;
  finance: FinanceRoutesDeps;
  stock: StockRoutesDeps;
  provisioning: ProvisioningRoutesDeps;
  tenant: TenantRoutesDeps;
};
