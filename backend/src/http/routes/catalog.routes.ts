/**
 * Rotas de catálogo: produtos, categorias e grupos de cozinha (estações de
 * produção).
 *
 * Endpoints:
 *   GET    /products                — listar produtos
 *   POST   /products                — criar produto (manager)
 *   PATCH  /products/:id            — atualizar produto (manager)
 *   PATCH  /products/:id/deactivate — desativar produto (manager)
 *   PATCH  /products/:id/activate   — ativar produto (manager)
 *   POST   /products/:id/image      — upload de imagem (manager)
 *   DELETE /products/:id/image      — remover imagem (manager)
 *   GET    /categories              — listar categorias
 *   POST   /categories              — criar categoria (manager)
 *   PATCH  /categories/:id          — atualizar categoria (manager)
 *   DELETE /categories/:id          — remover categoria (manager)
 *   GET    /kitchen-groups          — listar grupos de produção
 *   POST   /kitchen-groups          — criar grupo (manager)
 *   PATCH  /kitchen-groups/:id      — atualizar grupo (manager)
 *   DELETE /kitchen-groups/:id      — remover grupo (manager)
 *
 * Use cases: `backend/src/application/` (product, category, kitchen-group)
 * Testes: `backend/test/` (catalog)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { ensureTenantScope } from "../../infra/db/tenant-context.js";
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
import { imageExtByMime } from "./image-ext.js";

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
  featured: z.boolean().optional(),
  active: z.boolean().optional(),
  costPrice: z.number().min(0).optional(),
  lowStockThreshold: z.number().min(0).optional(),
  trackStock: z.boolean().optional(),
  unit: z.string().optional(),
  initialStock: z.number().min(0).optional(),
});
const productUpdateSchema = z
  .object({
    categoryId: z.string().min(1),
    kitchenGroupId: z.string().optional().nullable(),
    name: z.string().min(1),
    description: z.string().optional(),
    price: z.number().min(0),
    variations: z.array(variationGroupSchema).optional(),
    ifoodEnabled: z.boolean().optional(),
    ifoodSku: z.string().optional().nullable(),
    featured: z.boolean().optional(),
    active: z.boolean().optional(),
    costPrice: z.number().min(0).optional(),
    lowStockThreshold: z.number().min(0).optional(),
    trackStock: z.boolean().optional(),
    unit: z.string().optional(),
  })
  .partial();

const categoryCreateSchema = z.object({ name: z.string().min(1), displayOrder: z.number().int().optional() });
const categoryUpdateSchema = categoryCreateSchema.partial().extend({ active: z.boolean().optional() });

const kitchenGroupCreateSchema = z.object({ name: z.string().min(1), displayOrder: z.number().int().optional() });
const kitchenGroupUpdateSchema = kitchenGroupCreateSchema.partial().extend({ active: z.boolean().optional() });

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Products ----------
  app.get("/products", { preHandler: requireRole("manager", "waiter", "kitchen") }, async (req) => {
    const q = req.query as { category_id?: string; active?: string; q?: string; sort?: string; limit?: string; offset?: string };
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, () => listProductsUsecase({
      categoryId: q.category_id,
      active: q.active !== undefined ? q.active === "true" : undefined,
      search: q.q,
      sort: q.sort,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    }));
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
  app.get("/categories", async (req) => {
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, () => listCategoriesUsecase());
  });
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
  app.get("/kitchen-groups", async (req) => {
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, () => listKitchenGroupsUsecase());
  });
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
}
