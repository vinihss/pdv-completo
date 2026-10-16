import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../../http/middlewares/auth.middleware.js";
import { assignDeliveryCoordinate, listRegions, routeRegion, saveRegion } from "./delivery-gis.service.js";

const point = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const region = z.object({ id: z.string().optional(), name: z.string().min(1).max(120), geometry: z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(z.array(z.number()))).min(1) }) });

export async function deliveryGisRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("manager"));
  app.get("/delivery-regions", async () => listRegions());
  app.post("/delivery-regions", async (req) => saveRegion(region.parse(req.body)));
  app.post("/delivery-regions/deliveries/:id/coordinate", async (req) => {
    const { id } = req.params as { id: string };
    return assignDeliveryCoordinate(id, point.parse(req.body));
  });
  const createRoute = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return routeRegion(id);
  };
  app.post("/delivery-regions/:id/route", createRoute);
  // Alias em português para instalação/integração que segue os caminhos do brief.
  app.post("/regioes/:id/roteirizar", createRoute);
}
