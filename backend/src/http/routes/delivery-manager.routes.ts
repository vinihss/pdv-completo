import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listManagerDeliveriesUsecase,
  assignCourierUsecase,
  listCouriersUsecase,
  listCourierLocationsUsecase,
} from "../../application/self-service/delivery.usecases.js";
import { setDeliveryStatusUsecase } from "../../application/self-service/manager-delivery-status.usecase.js";

// Os 5 valores de `DeliveryStatus` (domain/customer-order-state.ts). Este enum
// estava com 4 — sem `cancelled`, que a máquina de estados e o filtro do
// entregador já usavam: quem pedisse ?status=cancelled no histórico do gerente
// recebia 400 do zod.
const statusEnum = z.enum(["awaiting_courier", "out_for_delivery", "delivered", "failed", "cancelled"]);
const assignSchema = z.object({ courierId: z.string() });
const setStatusSchema = z.object({
  status: z.enum(["awaiting_courier", "out_for_delivery", "delivered", "failed", "cancelled"]),
  // Só faz sentido (e é exigido pela UI) ao cancelar ou ao registrar falha.
  reason: z.string().max(300).optional(),
});

export async function deliveryManagerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("manager"));

  app.get("/manager/deliveries", async (req) => {
    const q = req.query as { status?: string };
    const statuses = q.status
      ? (q.status.split(",").map((s) => statusEnum.parse(s)) as Array<z.infer<typeof statusEnum>>)
      : undefined;
    return listManagerDeliveriesUsecase({ statuses });
  });

  app.patch("/manager/deliveries/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const body = assignSchema.parse(req.body);
    return assignCourierUsecase({ deliveryId: id, courierId: body.courierId, managerId: req.authUser!.sub });
  });

  // Correção de status pelo balcão. A transição é validada no usecase contra a
  // mesma `DELIVERY_TRANSITIONS` que o entregador obedece — o zod aqui só
  // garante que o valor é um status conhecido, não que ele é um destino válido.
  app.patch("/manager/deliveries/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const body = setStatusSchema.parse(req.body);
    return setDeliveryStatusUsecase({
      deliveryId: id,
      status: body.status,
      reason: body.reason,
      managerId: req.authUser!.sub,
    });
  });

  app.get("/manager/couriers", async () => listCouriersUsecase());

  // Mapa do gerente: última posição de cada entregador com entrega em rota.
  // Declarada como rota estática (não colide com `/manager/deliveries/:id`).
  app.get("/manager/deliveries/locations", async () => listCourierLocationsUsecase());
}
