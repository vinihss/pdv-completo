import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import { publicLookupRateLimit, publicWriteRateLimit, publicOrderRateLimit } from "../middlewares/rate-limit.middleware.js";
import { getPublicMenuUsecase } from "../../application/self-service/menu.usecases.js";
import {
  lookupCustomerByPhoneUsecase,
  createSelfServiceCustomerUsecase,
  addCustomerAddressUsecase,
} from "../../application/self-service/customer-address.usecases.js";
import {
  createSelfServiceOrderUsecase,
  getSelfServiceOrderStatusUsecase,
} from "../../application/self-service/order-intake.usecase.js";

const addressFields = {
  label: z.string().optional(),
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional(),
  neighborhood: z.string().min(1),
  city: z.string().min(1),
  reference: z.string().optional(),
  isDefault: z.boolean().optional(),
};

const lookupSchema = z.object({ phone: z.string().min(1) });

const createCustomerSchema = z.object({
  correlationId: z.string(),
  name: z.string().min(1),
  phone: z.string().min(1),
});

const addAddressSchema = z.object({ correlationId: z.string(), ...addressFields });

const createOrderSchema = z.object({
  correlationId: z.string(),
  // Opcional — a página passa "whatsapp" quando o cliente chegou pelo link
  // do bot (ver whatsapp-bot.usecases.ts#buildMenuLink); default "web" pra
  // quem chega direto na página sem passar pelo WhatsApp.
  channel: z.enum(["whatsapp", "web"]).default("web"),
  customerPhone: z.string().min(1),
  customerName: z.string().min(1),
  addressId: z.string().optional(),
  newAddress: z.object(addressFields).optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        selectedVariations: z.record(z.string(), z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
  paymentMethodIntent: z.enum(["cash", "card", "pix", "other"]),
});

// Sem authMiddleware — endpoints de cliente final, consumidos pela página
// externa (e internamente pelo webhook do WhatsApp, como chamada de função,
// não HTTP — ver 05-delivery-api-contracts.md).
export async function publicRoutes(app: FastifyInstance) {
  app.get("/public/menu", async () => getPublicMenuUsecase());

  app.post("/public/customers/lookup", { preHandler: publicLookupRateLimit }, async (req, reply) => {
    const body = lookupSchema.parse(req.body);
    const result = await lookupCustomerByPhoneUsecase(body.phone);
    if (!result) return reply.code(404).send({ error: { code: "not_found", message: "Cliente não encontrado." } });
    return result;
  });

  app.post("/public/customers", { preHandler: publicWriteRateLimit }, async (req, reply) => {
    const body = createCustomerSchema.parse(req.body);
    const result = await withIdempotency("POST /public/customers", body.correlationId, body, async () => {
      const created = await createSelfServiceCustomerUsecase({ name: body.name, phone: body.phone });
      return { status: 201, body: created };
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/public/customers/:id/addresses", { preHandler: publicWriteRateLimit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = addAddressSchema.parse(req.body);
    const result = await withIdempotency(
      `POST /public/customers/${id}/addresses`,
      body.correlationId,
      body,
      async () => {
        const created = await addCustomerAddressUsecase({ customerId: id, ...body });
        return { status: 201, body: created };
      }
    );
    return reply.code(result.status).send(result.body);
  });

  app.post("/public/orders", { preHandler: publicOrderRateLimit }, async (req, reply) => {
    const body = createOrderSchema.parse(req.body);
    const result = await withIdempotency("POST /public/orders", body.correlationId, body, async () => {
      const created = await createSelfServiceOrderUsecase(body);
      return { status: 201, body: created };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/public/orders/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    return getSelfServiceOrderStatusUsecase(id);
  });
}
