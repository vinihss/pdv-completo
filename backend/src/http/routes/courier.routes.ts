import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listCourierDeliveriesUsecase,
  dispatchDeliveryUsecase,
  deliverDeliveryUsecase,
  failDeliveryUsecase,
} from "../../application/self-service/delivery.usecases.js";

// "cancelled" (0018) entra no filtro: o entregador precisa conseguir listar
// o histórico do que foi cancelado no meio da rota.
const statusEnum = z.enum(["awaiting_courier", "out_for_delivery", "delivered", "failed", "cancelled"]);
const failSchema = z.object({ reason: z.string().min(1) });

export async function courierRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("courier"));

  app.get("/courier/deliveries", async (req) => {
    const q = req.query as { status?: string };
    const statuses = q.status
      ? (q.status.split(",").map((s) => statusEnum.parse(s)) as Array<z.infer<typeof statusEnum>>)
      : (["awaiting_courier", "out_for_delivery"] as const);
    return listCourierDeliveriesUsecase({ courierId: req.authUser!.sub, statuses: [...statuses] });
  });

  app.patch("/courier/deliveries/:id/dispatch", async (req) => {
    const { id } = req.params as { id: string };
    return dispatchDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub });
  });

  app.patch("/courier/deliveries/:id/deliver", async (req) => {
    const { id } = req.params as { id: string };
    return deliverDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub });
  });

  app.patch("/courier/deliveries/:id/fail", async (req) => {
    const { id } = req.params as { id: string };
    const body = failSchema.parse(req.body);
    return failDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub, reason: body.reason });
  });
}
