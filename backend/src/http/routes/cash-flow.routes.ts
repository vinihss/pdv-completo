import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import {
  getCurrentDrawerUsecase,
  listCashDrawersUsecase,
  getCashDrawerDetailUsecase,
  openCashDrawerUsecase,
  registerCashMovementUsecase,
  closeCashDrawerUsecase,
} from "../../application/cash-flow/cash-flow.usecases.js";

const noteSchema = z.string().max(200).optional();

const openSchema = z.object({
  correlationId: z.string(),
  openingAmount: z.number().min(0),
  note: noteSchema,
});

const movementSchema = z.object({
  correlationId: z.string(),
  amount: z.number().positive(),
  note: noteSchema,
});

const closeSchema = z.object({
  correlationId: z.string(),
  countedAmount: z.number().min(0),
});

// Caixa e gerente operam o fluxo de caixa.
const CASH_ROLES = ["cashier", "manager"] as const;

export async function cashFlowRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get("/cash-drawer/current", { preHandler: requireRole(...CASH_ROLES) }, async () => getCurrentDrawerUsecase());

  app.get("/cash-drawer", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    return listCashDrawersUsecase({
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get("/cash-drawer/:id", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const { id } = req.params as { id: string };
    return getCashDrawerDetailUsecase(id);
  });

  app.post("/cash-drawer/open", { preHandler: requireRole(...CASH_ROLES) }, async (req, reply) => {
    const body = openSchema.parse(req.body);
    const result = await withIdempotency("POST /cash-drawer/open", body.correlationId, body, async () => {
      const drawer = await openCashDrawerUsecase({
        userId: req.authUser!.sub,
        openingAmount: body.openingAmount,
        note: body.note,
      });
      return { status: 201, body: drawer };
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/cash-drawer/sangria", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const body = movementSchema.parse(req.body);
    return withIdempotency("POST /cash-drawer/sangria", body.correlationId, body, async () => {
      const movement = await registerCashMovementUsecase({
        userId: req.authUser!.sub,
        type: "sangria",
        amount: body.amount,
        note: body.note,
      });
      return { status: 200, body: movement };
    }).then((r) => r.body);
  });

  app.post("/cash-drawer/suprimento", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const body = movementSchema.parse(req.body);
    return withIdempotency("POST /cash-drawer/suprimento", body.correlationId, body, async () => {
      const movement = await registerCashMovementUsecase({
        userId: req.authUser!.sub,
        type: "suprimento",
        amount: body.amount,
        note: body.note,
      });
      return { status: 200, body: movement };
    }).then((r) => r.body);
  });

  app.post("/cash-drawer/close", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const body = closeSchema.parse(req.body);
    return withIdempotency("POST /cash-drawer/close", body.correlationId, body, async () => {
      const result = await closeCashDrawerUsecase({
        userId: req.authUser!.sub,
        countedAmount: body.countedAmount,
      });
      return { status: 200, body: result };
    }).then((r) => r.body);
  });
}