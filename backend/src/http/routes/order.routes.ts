import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import {
  openOrderUsecase,
  addItemsUsecase,
  updateItemStatusUsecase,
  deleteItemUsecase,
  registerPaymentUsecase,
  closeOrderUsecase,
  getOrderUsecase,
  listOrdersUsecase,
  listTablesUsecase,
} from "../../application/order/order.usecases.js";

const openOrderSchema = z.object({
  correlationId: z.string(),
  tableId: z.string().optional(),
  customerId: z.string().optional(),
  tabLabel: z.string().optional(),
});

const addItemsSchema = z.object({
  correlationId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        selectedVariations: z.record(z.string(), z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

const updateItemSchema = z.object({
  status: z.enum(["ready", "delivered"]),
  expectedVersion: z.number().int(),
});

const paymentSchema = z.object({
  paymentMethod: z.enum(["cash", "card", "pix", "other"]),
  confirmed: z.boolean(),
});

const closeSchema = z.object({ correlationId: z.string() });

export async function orderRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post("/orders", { preHandler: requireRole("waiter", "manager") }, async (req, reply) => {
    const body = openOrderSchema.parse(req.body);
    const result = await withIdempotency("POST /orders", body.correlationId, body, async () => {
      const order = await openOrderUsecase({ waiterId: req.authUser!.sub, ...body });
      return { status: 201, body: order };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/orders/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getOrderUsecase(id);
  });

  app.get("/orders", async (req) => {
    const q = req.query as { status?: "open" | "closed"; limit?: string; offset?: string };
    return listOrdersUsecase({
      status: q.status,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get("/tables", async () => listTablesUsecase());

  app.post(
    "/orders/:id/items",
    { preHandler: requireRole("waiter", "manager") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = addItemsSchema.parse(req.body);
      const result = await withIdempotency(`POST /orders/${id}/items`, body.correlationId, body, async () => {
        const items = await addItemsUsecase({ orderId: id, userId: req.authUser!.sub, items: body.items });
        return { status: 201, body: { data: items } };
      });
      return reply.code(result.status).send(result.body);
    }
  );

  app.patch("/orders/:id/items/:itemId", async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = updateItemSchema.parse(req.body);
    return updateItemStatusUsecase({
      orderId: id,
      itemId,
      userId: req.authUser!.sub,
      userRole: req.authUser!.role,
      newStatus: body.status,
      expectedVersion: body.expectedVersion,
    });
  });

  app.delete(
    "/orders/:id/items/:itemId",
    { preHandler: requireRole("waiter", "manager") },
    async (req, reply) => {
      const { id, itemId } = req.params as { id: string; itemId: string };
      await deleteItemUsecase({ orderId: id, itemId, userId: req.authUser!.sub });
      return reply.code(204).send();
    }
  );

  app.patch(
    "/orders/:id/payment",
    { preHandler: requireRole("waiter", "manager") },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = paymentSchema.parse(req.body);
      return registerPaymentUsecase({ orderId: id, userId: req.authUser!.sub, ...body });
    }
  );

  app.patch(
    "/orders/:id/close",
    { preHandler: requireRole("waiter", "manager") },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = closeSchema.parse(req.body);
      return withIdempotency(`PATCH /orders/${id}/close`, body.correlationId, body, async () => {
        const order = await closeOrderUsecase({ orderId: id, userId: req.authUser!.sub });
        return { status: 200, body: order };
      }).then((r) => r.body);
    }
  );
}
