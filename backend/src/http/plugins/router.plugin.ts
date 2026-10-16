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
import { deliveryGisRoutes } from "../../modules/delivery/delivery-gis.routes.js";

async function routerPlugin(app: FastifyInstance) {
    await app.register(authRoutes);
    await app.register(orderRoutes);
    await app.register(cashFlowRoutes);
    await app.register(catalogRoutes);
    await app.register(storeSettingsRoutes);
    await app.register(userRoutes);
    await app.register(customerRoutes);
    await app.register(customerAdminRoutes);
    await app.register(reportRoutes);
    await app.register(stockRoutes);
    await app.register(purchaseRoutes);
    await app.register(auditRoutes);
    await app.register(realtimeRoutes);
    await app.register(publicRoutes);
    await app.register(tenantRoutes);
    await app.register(courierRoutes);
    await app.register(deliveryManagerRoutes);
    await app.register(printRoutes);
    await app.register(alertRoutes);
    await app.register(provisioningRoutes);
    await app.register(uploadsRoutes);
    await app.register(refundRoutes);
    await app.register(deliveryGisRoutes);
}

// O uso do fastify-plugin evita que o Fastify crie um novo escopo isolado de contexto
export const appRouter = fp(routerPlugin);
