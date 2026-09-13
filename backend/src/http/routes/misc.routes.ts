import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { getStoreSettingsUsecase, updateStoreSettingsUsecase } from "../../application/store-settings.usecases.js";
import {
  listProductsUsecase,
  createProductUsecase,
  updateProductUsecase,
  setProductActiveUsecase,
} from "../../application/product.usecases.js";
import {
  listCategoriesUsecase,
  createCategoryUsecase,
  updateCategoryUsecase,
  deleteCategoryUsecase,
} from "../../application/category.usecases.js";
import { listUsersUsecase, createUserUsecase, updateUserUsecase, resetPinUsecase } from "../../application/user.usecases.js";
import { searchCustomersUsecase, createCustomerUsecase } from "../../application/customer.usecases.js";
import { salesReportUsecase } from "../../application/report.usecases.js";
import { listAuditLogUsecase } from "../../application/audit-log.usecases.js";

const storeSettingsSchema = z.object({
  merchantName: z.string(),
  merchantCity: z.string(),
  pixKey: z.string(),
  pixKeyType: z.enum(["cpf", "cnpj", "email", "phone", "random"]),
  usesTables: z.boolean(),
  kitchenEnabled: z.boolean(),
  enabledPaymentMethods: z.array(z.enum(["cash", "card", "pix", "other"])),
  kitchenPrepWarnMin: z.number().int().positive(),
  kitchenPrepUrgentMin: z.number().int().positive(),
  kitchenPickupUrgentMin: z.number().int().positive(),
  deliveryFee: z.number().min(0),
});

const productCreateSchema = z.object({
  categoryId: z.string(),
  name: z.string().min(1),
  price: z.number(),
  variations: z.array(z.any()).optional(),
});
const productUpdateSchema = productCreateSchema.partial();

const categoryCreateSchema = z.object({ name: z.string().min(1), displayOrder: z.number().int().optional() });
const categoryUpdateSchema = categoryCreateSchema.partial();

const userCreateSchema = z.object({ name: z.string().min(1), role: z.enum(["waiter", "kitchen", "manager", "courier"]) });
const userUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["waiter", "kitchen", "manager", "courier"]).optional(),
  active: z.boolean().optional(),
});

const customerCreateSchema = z.object({ name: z.string().min(1), phone: z.string().optional() });

export async function miscRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Store settings ----------
  app.get("/store-settings", async () => getStoreSettingsUsecase());
  app.put("/store-settings", { preHandler: requireRole("manager") }, async (req) => {
    const body = storeSettingsSchema.parse(req.body);
    return updateStoreSettingsUsecase(body);
  });

  // ---------- Products ----------
  app.get("/products", { preHandler: requireRole("manager", "waiter", "kitchen") }, async (req) => {
    const q = req.query as { category_id?: string; active?: string; limit?: string; offset?: string };
    return listProductsUsecase({
      categoryId: q.category_id,
      active: q.active !== undefined ? q.active === "true" : undefined,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  app.post("/products", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = productCreateSchema.parse(req.body);
    const created = await createProductUsecase(body);
    return reply.code(201).send(created);
  });
  app.patch("/products/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = productUpdateSchema.parse(req.body);
    return updateProductUsecase(id, body);
  });
  app.patch("/products/:id/deactivate", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return setProductActiveUsecase(id, false);
  });
  app.patch("/products/:id/activate", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return setProductActiveUsecase(id, true);
  });

  // ---------- Categories ----------
  app.get("/categories", async () => listCategoriesUsecase());
  app.post("/categories", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = categoryCreateSchema.parse(req.body);
    const created = await createCategoryUsecase(body);
    return reply.code(201).send(created);
  });
  app.patch("/categories/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = categoryUpdateSchema.parse(req.body);
    return updateCategoryUsecase(id, body);
  });
  app.delete("/categories/:id", { preHandler: requireRole("manager") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteCategoryUsecase(id);
    return reply.code(204).send();
  });

  // ---------- Users ----------
  app.get("/users", { preHandler: requireRole("manager") }, async () => listUsersUsecase());
  app.post("/users", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = userCreateSchema.parse(req.body);
    const created = await createUserUsecase(body);
    return reply.code(201).send(created);
  });
  app.patch("/users/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = userUpdateSchema.parse(req.body);
    return updateUserUsecase(id, body);
  });
  app.patch("/users/:id/reset-pin", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return resetPinUsecase(id);
  });

  // ---------- Customers ----------
  app.get("/customers", async (req) => {
    const q = req.query as { search?: string };
    return searchCustomersUsecase(q.search);
  });
  app.post("/customers", async (req, reply) => {
    const body = customerCreateSchema.parse(req.body);
    const created = await createCustomerUsecase(body);
    return reply.code(201).send(created);
  });

  // ---------- Reports ----------
  app.get("/reports/sales", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as {
      dateFrom?: string;
      dateTo?: string;
      customerQuery?: string;
      productId?: string;
      limit?: string;
      offset?: string;
    };
    return salesReportUsecase({
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      customerQuery: q.customerQuery,
      productId: q.productId,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });

  // ---------- Audit log ----------
  app.get("/audit-log", async (req) => {
    const q = req.query as { order_id?: string; limit?: string; offset?: string };
    return listAuditLogUsecase({
      orderId: q.order_id,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
}
