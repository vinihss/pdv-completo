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

/**
 * Fila padrão do entregador: o que ainda pede ação DELE mais o que ele acabou
 * de fazer e precisa ver na própria tela.
 *
 * `failed` entrou no default (bug real): o entregador que marcava a falha via
 * `PATCH /courier/deliveries/:id/fail` via a resposta HTTP — e na volta do
 * `reload()` seguinte a entrega tinha sumido da tela dele, porque o default era
 * só `awaiting_courier`/`out_for_delivery`. Só o gerente enxergava a falha, e o
 * entregador ficava sem nenhuma notícia do que deu errado (ele não pode
 * refazer: de `failed` a máquina só sai para `cancelled`, que é ação do
 * gerente). `failed` também NÃO é terminal, então continua sendo trabalho
 * pendente do balcão — esconder isso do dono da entrega era o pior dos dois.
 *
 * `delivered` e `cancelled` seguem FORA do default: são encerramentos, não fila
 * de trabalho. Quem precisa do histórico pede explicitamente
 * (`?status=delivered,cancelled`), que o `statusEnum` acima aceita.
 *
 * O corte por `courierId` continua vindo da sessão (`listCourierDeliveriesUsecase`
 * filtra por `req.authUser.sub`) — o entregador nunca vê entrega de outro, e
 * isso não muda aqui.
 */
const COURIER_DEFAULT_STATUSES = ["awaiting_courier", "out_for_delivery", "failed"] as const;

export async function courierRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("courier"));

  app.get("/courier/deliveries", async (req) => {
    const q = req.query as { status?: string };
    const statuses: Array<z.infer<typeof statusEnum>> = q.status
      ? q.status.split(",").map((s) => statusEnum.parse(s))
      : [...COURIER_DEFAULT_STATUSES];
    return listCourierDeliveriesUsecase({ courierId: req.authUser!.sub, statuses });
  });

  app.patch("/courier/deliveries/:id/dispatch", async (req) => {
    const { id } = req.params as { id: string };
    return dispatchDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub, storeId: req.storeId! });
  });

  app.patch("/courier/deliveries/:id/deliver", async (req) => {
    const { id } = req.params as { id: string };
    return deliverDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub, storeId: req.storeId! });
  });

  app.patch("/courier/deliveries/:id/fail", async (req) => {
    const { id } = req.params as { id: string };
    const body = failSchema.parse(req.body);
    return failDeliveryUsecase({ deliveryId: id, courierId: req.authUser!.sub, reason: body.reason });
  });
}
