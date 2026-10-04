/**
 * Rotas de cobrança no gateway (spec §9).
 *
 * Endpoints:
 *   POST  /orders/:id/payments      — criar cobrança (idempotente)
 *   GET   /orders/:id/payments      — listar tentativas
 *   GET   /payments/:paymentId      — detalhe
 *   POST  /payments/:paymentId/cancel  — pedir cancelamento
 *   POST  /payments/:paymentId/refund   — pedir estorno (parcial ou integral)
 *
 * Todas exigem autenticação e perfil de caixa: quem mexe com dinheiro.
 * A `POST` de criação aceita `correlationId` e passa por `withIdempotency`
 * (§17), mas a garantia de "não cobra duas vezes" NÃO está aqui — está no
 * reuso da cobrança viva, dentro do usecase. Esta camada cobre o retry do MESMO
 * request; aquela cobre o "dois requests de comandas diferentes".
 *
 * Use cases: application/payment/payment.usecases.ts
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import {
  cancelPaymentUsecase,
  createPaymentUsecase,
  getPaymentUsecase,
  listOrderPaymentsUsecase,
  requestRefundUsecase,
} from "../../application/payment/payment.usecases.js";

const createSchema = z.object({
  correlationId: z.string(),
  // Só o que o gateway sabe fazer. `cash` e `other` continuam existindo no
  // balcão (order_payment) e NÃO são cobrados pelo Pagar.me.
  method: z.enum(["pix", "credit_card"]),
  // Token do cartão, gerado no navegador pelo checkout do Pagar.me. PAN e CVV
  // nunca chegam aqui — não há campo para eles neste schema (PCI).
  cardToken: z.string().optional(),
  cardId: z.string().optional(),
  installments: z.number().int().positive().max(12).optional(),
});

const refundSchema = z.object({
  // Ausente = estorno integral (spec §9.5).
  amount: z.number().positive().optional(),
  reason: z.string().max(200).optional(),
});

export async function paymentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post("/orders/:id/payments", { preHandler: requireRole("cashier", "manager") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createSchema.parse(req.body);
    const result = await withIdempotency(`POST /orders/${id}/payments`, body.correlationId, body, async () => {
      const payment = await createPaymentUsecase({
        orderId: id,
        method: body.method,
        cardToken: body.cardToken,
        cardId: body.cardId,
        installments: body.installments,
      });
      return { status: 201, body: payment };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/orders/:id/payments", { preHandler: requireRole("cashier", "manager", "waiter") }, async (req) => {
    const { id } = req.params as { id: string };
    return { data: await listOrderPaymentsUsecase(id) };
  });

  app.get("/payments/:paymentId", { preHandler: requireRole("cashier", "manager", "waiter") }, async (req) => {
    const { paymentId } = req.params as { paymentId: string };
    return getPaymentUsecase(paymentId);
  });

  app.post("/payments/:paymentId/cancel", { preHandler: requireRole("cashier", "manager") }, async (req) => {
    const { paymentId } = req.params as { paymentId: string };
    return cancelPaymentUsecase({ paymentId, userId: req.authUser!.sub });
  });

  app.post("/payments/:paymentId/refund", { preHandler: requireRole("manager") }, async (req) => {
    // Só manager estorna: é a única operação do sistema que tira dinheiro que
    // já entrou (o caixa tem sangria própria, com o próprio papel e o próprio
    // registro de movimento).
    const { paymentId } = req.params as { paymentId: string };
    const body = refundSchema.parse(req.body ?? {});
    return requestRefundUsecase({
      paymentId,
      amount: body.amount,
      reason: body.reason,
      userId: req.authUser!.sub,
    });
  });
}