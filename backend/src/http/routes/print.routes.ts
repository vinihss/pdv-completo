import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { Errors } from "../../domain/errors.js";
import {
  reprintOrder,
  getPrintJobsForOrder,
  getPrinterStatus,
} from "../../integrations/printer/printer.usecases.js";
import { printerClient } from "../../integrations/printer/printer.client.js";

const destinationSchema = z.object({ destination: z.enum(["kitchen", "courier"]) });

export async function printRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Impressão manual — reimprime a comanda inteira para o destino escolhido.
  app.post("/orders/:id/print", { preHandler: requireRole("waiter", "manager") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = destinationSchema.parse(req.body);
    const result = await reprintOrder(id, body.destination);
    if (!result) throw Errors.notFound("Comanda");
    return result;
  });

  // Status dos jobs de impressão de uma coanda.
  app.get("/orders/:id/print-status", { preHandler: requireRole("waiter", "manager") }, async (req) => {
    const { id } = req.params as { id: string };
    return { orderId: id, jobs: await getPrintJobsForOrder(id) };
  });

  // Status das impressoras (DLE EOT) — gerente.
  app.get("/printers/status", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { destination?: string };
    if (q.destination) {
      const status = await getPrinterStatus(q.destination);
      if (!status) throw Errors.notFound("Impressora");
      return status;
    }
    const statuses = await Promise.all([
      getPrinterStatus("kitchen"),
      getPrinterStatus("courier"),
    ]);
    return { printers: statuses.filter(Boolean) };
  });

  // Health check do daemon — manager.
  app.get("/printers/health", { preHandler: requireRole("manager") }, async () => {
    const ok = await printerClient.health();
    return { daemon: ok ? "online" : "offline" };
  });
}
