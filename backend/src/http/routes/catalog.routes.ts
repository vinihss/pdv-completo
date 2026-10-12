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
// Schemas de validação — nivel de módulo (precisam ser visíveis em todo o arquivo
// para evitar erro "used before declaration" do TypeScript dentro dos handlers).
const variationGroupSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  required: z.boolean(),
  allowMultiple: z.boolean(),
});

const productCreateSchema = z.object({
  categoryId: z.string().min(1),
  kitchenGroupId: z.string(),
  name: z.string().min(1),
  description: z.string(),
  price: z.number().min(0),
  variations: z.array(variationGroupSchema),
  ifoodEnabled: z.boolean(),
  ifoodSku: z.string(),
  featured: z.boolean(),
  active: z.boolean(),
  costPrice: z.number().min(0),
  lowStockThreshold: z.number().min(0),
  trackStock: z.boolean(),
  unit: z.string(),
  initialStock: z.number().min(0),
});

const productUpdateSchema = z.object({
  categoryId: z.string(),
  kitchenGroupId: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.number().min(0),
  variations: z.array(variationGroupSchema),
  ifoodEnabled: z.boolean(),
  ifoodSku: z.string(),
  featured: z.boolean(),
  active: z.boolean(),
  costPrice: z.number().min(0),
  lowStockThreshold: z.number().min(0),
  trackStock: z.boolean(),
  unit: z.string(),
  initialStock: z.number().min(0),
});

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
} from "../../infra/composition/default-usecases.js";
import {
  listCategoriesUsecase,
  createCategoryUsecase,
  updateCategoryUsecase,
  deleteCategoryUsecase,
} from "../../infra/composition/default-usecases.js";
import {
  listKitchenGroupsUsecase,
  createKitchenGroupUsecase,
  updateKitchenGroupUsecase,
  deleteKitchenGroupUsecase,
} from "../../infra/composition/default-usecases.js";
import { imageExtByMime } from "./image-ext.js";

export const catalogRoutes = {};