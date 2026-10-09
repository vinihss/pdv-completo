import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import { refundOrderPaymentUsecase, listOrderRefundsUsecase } from "../../application/refund/refund.usecases.js";

// ============================================================================
// Rotas de estorno de pagamentos (Bloco 4 ROADMAP-CAIXA.md)
// ============================================================================
//
// Endpoints:
//   POST /orders/:id/payments/:paymentId/refunds  — criar estorno (idempotente)
//   GET  /orders/:id/refunds                       — listar estornos do pedido
//
// Ambas manager-only (estorno é operação sensível, exige alçada).
//
// Use cases: `backend/src/application/refund/refund.usecases.ts`
// Testes: `backend/test/refund.test.ts`
// ============================================================================

const createRefundBody = z.object({
  correlationId: z.string(),
  amount: z.number().positive(),
  reason: z.string().min(3).max(500),
  notes: z.string().max(1000).optional(),
});

export async function refundRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /orders/:id/payments/:paymentId/refunds — criar estorno
  app.post(
    "/orders/:id/payments/:paymentId/refunds",
    {
      preHandler: requireRole("manager"),
    },
    async (req, reply) => {
      const { id: orderId, paymentId } = req.params as { id: string; paymentId: string };
      const body = createRefundBody.parse(req.body);
      const userId = req.authUser!.sub;

      const result = await withIdempotency(
        `POST /orders/${orderId}/payments/${paymentId}/refunds`,
        body.correlationId,
        body,
        async () => {
          const refund = await refundOrderPaymentUsecase({
            orderId,
            paymentId,
            amount: body.amount,
            reason: body.reason,
            userId,
            notes: body.notes,
          });
          return { status: 201, body: refund };
        }
      );

      return reply.status(result.status).send(result.body);
    }
  );

  // GET /orders/:id/refunds — listar estornos do pedido
  app.get(
    "/orders/:id/refunds",
    {
      preHandler: requireRole("manager"),
    },
    async (req) => {
      const { id: orderId } = req.params as { id: string };
      return await listOrderRefundsUsecase(orderId);
    }
  );
}
