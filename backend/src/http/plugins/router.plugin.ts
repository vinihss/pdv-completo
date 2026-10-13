import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

// Importações de rotas agrupadas
import { authRoutes } from "../routes/auth.routes.js";
import { orderRoutes } from "../routes/order.routes.js";
import { cashFlowRoutes } from "../routes/cash-flow.routes.js";
import { catalogRoutes } from "../routes/catalog.routes.js";
import { storeSettingsRoutes } from "../routes/store-settings.routes.js";
import { userRoutes } from "../routes/user.routes.js";
import { customerRoutes } from "../routes/customer.routes.js";
import { customerAdminRoutes } from "../routes/customer-admin.routes.js";
import { reportRoutes } from "../routes/report.routes.js";
import { stockRoutes } from "../routes/stock.routes.js";
import { purchaseRoutes } from "../routes/purchase.routes.js";
import { auditRoutes } from "../routes/audit.routes.js";
import { realtimeRoutes } from "../routes/realtime.routes.js";
import { publicRoutes } from "../routes/public.routes.js";
import { tenantRoutes } from "../routes/tenant.routes.js";
import { courierRoutes } from "../routes/courier.routes.js";
import { deliveryManagerRoutes } from "../routes/delivery-manager.routes.js";
import { printRoutes } from "../routes/print.routes.js";
import { alertRoutes } from "../routes/alert.routes.js";
import { provisioningRoutes } from "../routes/provisioning.routes.js";
import { uploadsRoutes } from "../routes/uploads.routes.js";
import { refundRoutes } from "../routes/refund.routes.js";
import type { RoutesDeps } from "../../composition/routes-deps.js";

interface RouterOptions {
  container: RoutesDeps;
}

async function routerPlugin(app: FastifyInstance, options: RouterOptions) {
  const deps = options.container;

  await app.register(authRoutes, { deps: deps.auth });
  await app.register(orderRoutes, { deps: deps.order });
  await app.register(cashFlowRoutes, { deps: deps.cashFlow });
  await app.register(catalogRoutes, { deps: deps.catalog });
  await app.register(storeSettingsRoutes, { deps: deps.storeSettings });
  await app.register(userRoutes, { deps: deps.user });
  await app.register(customerRoutes, { deps: deps.customer });
  await app.register(customerAdminRoutes, { deps: deps.customer });
  await app.register(reportRoutes, { deps: deps.reports });
  await app.register(stockRoutes, { deps: deps.stock });
  await app.register(purchaseRoutes, { deps: deps.finance });
  await app.register(auditRoutes, { deps: deps.auditLog });
  await app.register(realtimeRoutes);
  await app.register(publicRoutes, { deps: { selfService: deps.selfService, storeSettings: deps.storeSettings } });
  await app.register(tenantRoutes, { deps: deps.tenant });
  await app.register(courierRoutes, { deps: deps.selfService });
  await app.register(deliveryManagerRoutes, { deps: deps.selfService });
  await app.register(printRoutes);
  await app.register(alertRoutes, { deps: deps.alert });
  await app.register(provisioningRoutes, { deps: deps.provisioning });
  await app.register(uploadsRoutes);
  await app.register(refundRoutes, { deps: deps.finance });
}

// O uso do fastify-plugin evita que o Fastify crie um novo escopo isolado de
// contexto. As dependências chegam pelas `opts` (o `container` montado pela
// composition root em `composition/build-app.ts`).
export const appRouter = fp(routerPlugin);
