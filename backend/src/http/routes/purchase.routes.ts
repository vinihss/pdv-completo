/**
 * Rotas de compras: fornecedores e documentos de compra (multi-item).
 *
 * Endpoints:
 *   GET    /suppliers      — listar fornecedores (manager)
 *   POST   /suppliers      — criar fornecedor (manager)
 *   PATCH  /suppliers/:id  — atualizar fornecedor (manager)
 *   POST   /purchases      — criar compra (manager)
 *   GET    /purchases      — listar compras (manager)
 *   GET    /purchases/:id  — detalhe da compra (manager)
 *
 * Use cases: `backend/src/application/purchase/purchase.usecases.ts`
 * Testes: `backend/test/` (purchase)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listSuppliersUsecase,
  createSupplierUsecase,
  updateSupplierUsecase,
  createPurchaseUsecase,
  listPurchasesUsecase,
  getPurchaseUsecase,
} from "../../infra/composition/default-usecases.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";

// Compras (baseline 0001) — documento multi-item.
const supplierCreateSchema = z.object({ name: z.string().min(1), phone: z.string().optional().nullable(), taxId: z.string().optional().nullable() });
const supplierUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  active: z.boolean().optional(),
});
const purchaseItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  batchNo: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
});
const purchaseCreateSchema = z.object({
  supplierId: z.string().optional().nullable(),
  invoiceNumber: z.string().optional().nullable(),
  issuedOn: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  items: z.array(purchaseItemSchema).min(1),
  correlationId: z.string().min(1),
});

export async function purchaseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Fornecedores (baseline 0001) ----------
  app.get("/suppliers", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { active_only?: string; limit?: string; offset?: string };
    return listSuppliersUsecase({
      activeOnly: q.active_only === "true",
      limit: Math.min(Number(q.limit ?? 100), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  app.post("/suppliers", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = supplierCreateSchema.parse(req.body);
    const created = await createSupplierUsecase(body, req.authUser!.sub);
    return reply.code(201).send(created);
  });
  app.patch("/suppliers/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = supplierUpdateSchema.parse(req.body);
    return updateSupplierUsecase(id, body, req.authUser!.sub);
  });

  // ---------- Compras (documento multi-item) ----------
  app.post("/purchases", { preHandler: requireRole("manager") }, async (req, reply) => {
    const body = purchaseCreateSchema.parse(req.body);
    const created = await withIdempotency("POST /purchases", body.correlationId, body, async () => {
      const purchase = await createPurchaseUsecase(
        {
          supplierId: body.supplierId,
          invoiceNumber: body.invoiceNumber,
          issuedOn: body.issuedOn,
          note: body.note,
          items: body.items,
        },
        req.authUser!.sub
      );
      return { status: 201, body: purchase };
    });
    return reply.code(created.status).send(created.body);
  });
  app.get("/purchases", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    return listPurchasesUsecase({ limit: Math.min(Number(q.limit ?? 50), 200), offset: Number(q.offset ?? 0) });
  });
  app.get("/purchases/:id", { preHandler: requireRole("manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return getPurchaseUsecase(id);
  });
}
