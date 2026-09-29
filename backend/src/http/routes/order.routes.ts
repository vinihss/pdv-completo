/**
 * Rotas de comandas (orders).
 *
 * Endpoints:
 *   POST   /orders                    — abrir comanda (idempotente)
 *   GET    /orders                    — listar comandas
 *   GET    /orders/:id                — detalhe da comanda
 *   POST   /orders/:id/items          — lançar itens em lote (idempotente)
 *   PATCH  /orders/:id/items/:itemId  — atualizar item (lock otimista)
 *   DELETE /orders/:id/items/:itemId  — remover item
 *   PATCH  /orders/:id/status         — mudar status
 *   PATCH  /orders/:id/close          — fechar comanda (idempotente)
 *   PUT    /orders/:id/payments       — registrar pagamento
 *   PATCH  /orders/:id/payments/:paymentId — confirmar pagamento
 *   DELETE /orders/:id/payments/:paymentId — remover pagamento
 *   PATCH  /orders/:id/payment        — legado: pagamento de intenção única
 *   GET    /tables                    — listar mesas
 *   POST   /tables                    — criar mesa
 *   PATCH  /tables/:id                — atualizar mesa
 *
 * Use cases: `backend/src/application/order/order.usecases.ts`
 * Testes: `backend/test/order-flow.test.ts`
 */
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
  setOrderPaymentsUsecase,
  confirmOrderPaymentUsecase,
  deleteOrderPaymentUsecase,
  closeOrderUsecase,
  cancelOrderUsecase,
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
        selectedVariations: z.record(z.string(), z.string().or(z.array(z.string()))).optional(),
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

const paymentLineSchema = z.object({
  method: z.enum(["cash", "card", "pix", "other"]),
  amount: z.number().positive(),
  received: z.number().positive().optional(),
  confirmed: z.boolean().optional(),
});

const setPaymentsSchema = z.object({
  payments: z.array(paymentLineSchema).min(1),
});

const closeSchema = z.object({ correlationId: z.string() });
const cancelSchema = z.object({ correlationId: z.string(), reason: z.string().min(1) });

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

  // Pagamento fracionado: uma comanda pode ser paga com várias formas
  // (dinheiro + cartão + pix…). PUT substitui o conjunto de linhas de uma vez;
  // confirmar/remover são PATCH/DELETE por linha.
  app.put(
    "/orders/:id/payments",
    { preHandler: requireRole("waiter", "manager") },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = setPaymentsSchema.parse(req.body);
      return setOrderPaymentsUsecase({ orderId: id, userId: req.authUser!.sub, payments: body.payments });
    }
  );

  app.patch(
    "/orders/:id/payments/:paymentId",
    { preHandler: requireRole("waiter", "manager") },
    async (req) => {
      const { id, paymentId } = req.params as { id: string; paymentId: string };
      return confirmOrderPaymentUsecase({ orderId: id, paymentId, userId: req.authUser!.sub });
    }
  );

  app.delete(
    "/orders/:id/payments/:paymentId",
    { preHandler: requireRole("waiter", "manager") },
    async (req, reply) => {
      const { id, paymentId } = req.params as { id: string; paymentId: string };
      await deleteOrderPaymentUsecase({ orderId: id, paymentId, userId: req.authUser!.sub });
      return reply.code(204).send();
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

  // Restrito a manager — anula a comanda sem venda, diferente de close
  // (que sempre implica pagamento confirmado). Mais consequente que close,
  // por isso mais restrito que ele.
  app.patch(
    "/orders/:id/cancel",
    { preHandler: requireRole("manager") },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = cancelSchema.parse(req.body);
      return withIdempotency(`PATCH /orders/${id}/cancel`, body.correlationId, body, async () => {
        const order = await cancelOrderUsecase({ orderId: id, userId: req.authUser!.sub, reason: body.reason });
        return { status: 200, body: order };
      }).then((r) => r.body);
    }
  );
}
