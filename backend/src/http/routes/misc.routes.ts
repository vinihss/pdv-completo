import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { getStoreSettingsUsecase, updateStoreSettingsUsecase, saveStoreLogoUsecase, clearStoreLogoUsecase } from "../../application/store-settings.usecases.js";
import {
  listProductsUsecase,
  createProductUsecase,
  updateProductUsecase,
  setProductActiveUsecase,
  saveProductImageUsecase,
  clearProductImageUsecase,
} from "../../application/product.usecases.js";
import {
  listCategoriesUsecase,
  createCategoryUsecase,
  updateCategoryUsecase,
  deleteCategoryUsecase,
} from "../../application/category.usecases.js";
import {
  listKitchenGroupsUsecase,
  createKitchenGroupUsecase,
  updateKitchenGroupUsecase,
  deleteKitchenGroupUsecase,
} from "../../application/kitchen-group.usecases.js";
import { listUsersUsecase, createUserUsecase, updateUserUsecase, resetPinUsecase } from "../../application/user.usecases.js";
import { searchCustomersUsecase, createCustomerUsecase } from "../../application/customer.usecases.js";
import { salesReportUsecase } from "../../application/report.usecases.js";
import { listAuditLogUsecase } from "../../application/audit-log.usecases.js";

const storeSettingsSchema = z.object({
  merchantName: z.string(),
  merchantCity: z.string(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  pixKey: z.string(),
  pixKeyType: z.enum(["cpf", "cnpj", "email", "phone", "random"]),
  usesTables: z.boolean(),
  kitchenEnabled: z.boolean(),
  usesDelivery: z.boolean(),
  ifoodIntegrationEnabled: z.boolean(),
  enabledPaymentMethods: z.array(z.enum(["cash", "card", "pix", "other"])),
  kitchenPrepWarnMin: z.number().int().positive(),
  kitchenPrepUrgentMin: z.number().int().positive(),
  kitchenPickupUrgentMin: z.number().int().positive(),
  deliveryFee: z.number().min(0),
});

const variationGroupSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  required: z.boolean().optional(),
  allowMultiple: z.boolean().optional(),
});

const productCreateSchema = z.object({
  categoryId: z.string().min(1),
  kitchenGroupId: z.string().optional().nullable(),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().min(0),
  variations: z.array(variationGroupSchema).optional(),
  ifoodEnabled: z.boolean().optional(),
  ifoodSku: z.string().optional().nullable(),
  active: z.boolean().optional(),
});
const productUpdateSchema = productCreateSchema.partial();

// MIME aceitos no upload de foto → extensão de arquivo
const imageExtByMime: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const categoryCreateSchema = z.object({ name: z.string().min(1), displayOrder: z.number().int().optional() });
const categoryUpdateSchema = categoryCreateSchema.partial().extend({ active: z.boolean().optional() });

const kitchenGroupCreateSchema = z.object({ name: z.string().min(1), displayOrder: z.number().int().optional() });
const kitchenGroupUpdateSchema = kitchenGroupCreateSchema.partial().extend({ active: z.boolean().optional() });

const userCreateSchema = z.object({ name: z.string().min(1), role: z.enum(["waiter", "kitchen", "manager", "courier", "cashier"]) });
const userUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["waiter", "kitchen", "manager", "courier", "cashier"]).optional(),
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
  // Logo — upload multipart (multipart/form-data, campo "logo")
  app.post("/store-settings/logo", { preHandler: requireRole("manager") }, async (req) => {
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "logo" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "logo" });
    const buffer = await file.toBuffer();
    return saveStoreLogoUsecase({ buffer, ext }, req.authUser!.sub);
  });
  // Logo — remover
  app.delete("/store-settings/logo", { preHandler: requireRole("manager") }, async (req) => {
    return clearStoreLogoUsecase(req.authUser!.sub);
  });

  // ---------- Products ----------
  app.get("/products", { preHandler: requireRole("manager", "waiter", "kitchen") }, async (req) => {
    const q = req.query as { category_id?: string; active?: string; q?: string; limit?: string; offset?: string };
    return listProductsUsecase({
      categoryId: q.category_id,
      active: q.active !== undefined ? q.active === "true" : undefined,
      search: q.q,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  app.post("/products", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = productCreateSchema.parse(req.body);
    const created = await createProductUsecase(body, req.authUser!.sub);
    return reply.code(201).send(created);
  });
  app.patch("/products/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = productUpdateSchema.parse(req.body);
    return updateProductUsecase(id, body, req.authUser!.sub);
  });
  app.patch("/products/:id/deactivate", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return setProductActiveUsecase(id, false, req.authUser!.sub);
  });
  app.patch("/products/:id/activate", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return setProductActiveUsecase(id, true, req.authUser!.sub);
  });
  // Foto — upload multipart (multipart/form-data, campo "image")
  app.post("/products/:id/image", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "image" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "image" });
    const buffer = await file.toBuffer();
    return saveProductImageUsecase(id, { buffer, ext }, req.authUser!.sub);
  });
  // Foto — remover
  app.delete("/products/:id/image", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return clearProductImageUsecase(id, req.authUser!.sub);
  });

  // ---------- Categories ----------
  app.get("/categories", async () => listCategoriesUsecase());
  app.post("/categories", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = categoryCreateSchema.parse(req.body);
    const created = await createCategoryUsecase(body, req.authUser!.sub);
    return reply.code(201).send(created);
  });
  app.patch("/categories/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = categoryUpdateSchema.parse(req.body);
    return updateCategoryUsecase(id, body, req.authUser!.sub);
  });
  app.delete("/categories/:id", { preHandler: requireRole("manager") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteCategoryUsecase(id, req.authUser!.sub);
    return reply.code(204).send();
  });

  // ---------- Kitchen groups (estações de produção) ----------
  app.get("/kitchen-groups", async () => listKitchenGroupsUsecase());
  app.post("/kitchen-groups", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = kitchenGroupCreateSchema.parse(req.body);
    const created = await createKitchenGroupUsecase(body, req.authUser!.sub);
    return reply.code(201).send(created);
  });
  app.patch("/kitchen-groups/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = kitchenGroupUpdateSchema.parse(req.body);
    return updateKitchenGroupUsecase(id, body, req.authUser!.sub);
  });
  app.delete("/kitchen-groups/:id", { preHandler: requireRole("manager") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteKitchenGroupUsecase(id, req.authUser!.sub);
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
  // Especificado como ferramenta do gerente — garçom não consulta o log global
  // (o histórico da própria comanda dele é outra concernência, ver spec §4.4.1).
  app.get("/audit-log", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { order_id?: string; limit?: string; offset?: string };
    return listAuditLogUsecase({
      orderId: q.order_id,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
}
