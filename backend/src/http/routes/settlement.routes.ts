import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import {
  registerSettlementUsecase,
  markSettledUsecase,
  listSettlementsUsecase,
  getSettlementByOrderIdUsecase,
} from "../../application/settlement/settlement.usecases.js";

// ============================================================================
// Rotas de settlement iFood (Bloco 5 ROADMAP-CAIXA.md)
// ============================================================================
//
// Endpoints:
//   POST   /settlements                    — registrar settlement (manager)
//   PATCH  /settlements/:id/settle         — marcar como recebido (manager)
//   GET    /settlements                    — listar com filtros (manager)
//   GET    /settlements/by-order/:orderId  — buscar por pedido (manager, waiter)
//
// Settlement separa receita bruta de repasse líquido nos pedidos iFood.
//
// Use cases: `backend/src/application/settlement/settlement.usecases.ts`
// Testes: `backend/test/settlement.test.ts`
// ============================================================================

const registerSettlementBody = z.object({
  correlationId: z.string(),
  orderId: z.string(),
  channel: z.string(),
  grossAmount: z.number().nonnegative(),
  commissionAmount: z.number().nonnegative(),
  marketplaceFee: z.number().nonnegative().optional(),
  deliveryFeeSubsidy: z.number().nonnegative().optional(),
  payoutAmount: z.number().nonnegative().optional(),
  payoutExpectedAt: z.string().optional(),
  externalRef: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

const markSettledBody = z.object({
  correlationId: z.string(),
  payoutSettledAt: z.string(),
});

const listSettlementsQuery = z.object({
  channel: z.string().optional(),
  payout_status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /settlements — registrar settlement
  app.post(
    "/settlements",
    {
      preHandler: requireRole("manager"),
    },
    async (req, reply) => {
      const body = registerSettlementBody.parse(req.body);
      const userId = req.authUser!.sub;

      const result = await withIdempotency(
        "POST /settlements",
        body.correlationId,
        body,
        async () => {
          const settlement = await registerSettlementUsecase({
            orderId: body.orderId,
            channel: body.channel,
            grossAmount: body.grossAmount,
            commissionAmount: body.commissionAmount,
            marketplaceFee: body.marketplaceFee,
            deliveryFeeSubsidy: body.deliveryFeeSubsidy,
            payoutAmount: body.payoutAmount,
            payoutExpectedAt: body.payoutExpectedAt,
            externalRef: body.externalRef,
            notes: body.notes,
            userId,
          });
          return { status: 201, body: settlement };
        }
      );

      return reply.status(result.status).send(result.body);
    }
  );

  // PATCH /settlements/:id/settle — marcar como recebido
  app.patch(
    "/settlements/:id/settle",
    {
      preHandler: requireRole("manager"),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = markSettledBody.parse(req.body);
      const userId = req.authUser!.sub;

      const result = await withIdempotency(
        `PATCH /settlements/${id}/settle`,
        body.correlationId,
        body,
        async () => {
          const settlement = await markSettledUsecase({
            settlementId: id,
            payoutSettledAt: body.payoutSettledAt,
            userId,
          });
          return { status: 200, body: settlement };
        }
      );

      return result.body;
    }
  );

  // GET /settlements — listar com filtros
  app.get(
    "/settlements",
    {
      preHandler: requireRole("manager"),
    },
    async (req) => {
      const query = listSettlementsQuery.parse(req.query);
      return await listSettlementsUsecase({
        channel: query.channel,
        payoutStatus: query.payout_status,
        from: query.from,
        to: query.to,
      });
    }
  );

  // GET /settlements/by-order/:orderId — buscar por pedido
  app.get(
    "/settlements/by-order/:orderId",
    {
      preHandler: requireRole("manager", "waiter"),
    },
    async (req) => {
      const { orderId } = req.params as { orderId: string };
      return await getSettlementByOrderIdUsecase(orderId);
    }
  );
}
