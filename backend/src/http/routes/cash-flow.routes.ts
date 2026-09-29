/**
 * Rotas de fluxo de caixa (cash flow).
 *
 * Endpoints:
 *   GET  /cash-drawer/current  — caixa atual
 *   GET  /cash-drawer          — listar caixas
 *   GET  /cash-drawer/summary  — resumo por período
 *   GET  /cash-drawer/:id      — detalhe do caixa
 *   POST /cash-drawer/open     — abrir caixa (idempotente)
 *   POST /cash-drawer/sangria  — sangria (idempotente)
 *   POST /cash-drawer/suprimento — suprimento (idempotente)
 *   POST /cash-drawer/close    — fechar caixa (idempotente)
 *
 * Use cases: `backend/src/application/cash-flow/cash-flow.usecases.ts`
 * Testes: `backend/test/cash-flow.test.ts`
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import { dayStart, dayEnd, isValidTz } from "../../application/cash-flow/day-bounds.js";
import {
  getCurrentDrawerUsecase,
  listCashDrawersUsecase,
  getCashDrawerDetailUsecase,
  sumCashDrawersSummaryUsecase,
  openCashDrawerUsecase,
  registerCashMovementUsecase,
  closeCashDrawerUsecase,
} from "../../application/cash-flow/cash-flow.usecases.js";

const noteSchema = z.string().max(200).optional();

// Offset opcional de fuso para interpretar datas "YYYY-MM-DD" como um dia
// local na loja (ex: "-03:00" para GMT-3). Default UTC → mesmo comportamento
// anterior.
const tzSchema = z
  .string()
  .optional()
  .refine(isValidTz, "tz deve ser um offset como -03:00 ou +05:30 (dentro de ±12h)");

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
  note: noteSchema,
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

  // Aceita datas ISO completas ou "YYYY-MM-DD" (vira início/fim do dia). Com
  // `tz` (±HH:MM), o dia é interpretado no fuso local da loja.
  app.get("/cash-drawer/summary", { preHandler: requireRole(...CASH_ROLES) }, async (req) => {
    const q = req.query as { from?: string; to?: string; tz?: string };
    const tz = tzSchema.parse(q.tz);
    return sumCashDrawersSummaryUsecase({
      from: q.from ? dayStart(q.from, tz) : "0001-01-01T00:00:00.000Z",
      to: q.to ? dayEnd(q.to, tz) : "9999-12-31T23:59:59.999Z",
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
        note: body.note,
      });
      return { status: 200, body: result };
    }).then((r) => r.body);
  });
}