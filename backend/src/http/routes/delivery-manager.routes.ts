import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listManagerDeliveriesUsecase,
  assignCourierUsecase,
  listCouriersUsecase,
} from "../../application/self-service/delivery.usecases.js";

const statusEnum = z.enum(["awaiting_courier", "out_for_delivery", "delivered", "failed"]);
const assignSchema = z.object({ courierId: z.string() });

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

  app.get("/manager/couriers", async () => listCouriersUsecase());
}
