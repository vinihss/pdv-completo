import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";
import { publicLookupRateLimit, publicWriteRateLimit, publicOrderRateLimit, publicCartRateLimit } from "../middlewares/rate-limit.middleware.js";
import { getPublicMenuUsecase } from "../../application/self-service/menu.usecases.js";
import { getStoreSettingsUsecase } from "../../application/store-settings.usecases.js";
import { Errors } from "../../domain/errors.js";
import {
  lookupCustomerByPhoneUsecase,
  createSelfServiceCustomerUsecase,
  addCustomerAddressUsecase,
} from "../../application/self-service/customer-address.usecases.js";
import {
  createSelfServiceOrderUsecase,
  getSelfServiceOrderStatusUsecase,
  getActiveSelfServiceOrderByPhoneUsecase,
} from "../../application/self-service/order-intake.usecase.js";
import { cancelSelfServiceOrderUsecase } from "../../application/self-service/cancel-order.usecase.js";
import {
  getCustomerCartUsecase,
  saveCustomerCartUsecase,
  clearCustomerCartUsecase,
} from "../../application/self-service/cart.usecases.js";
import { calcularEntregaUsecase } from "../../application/delivery/calcular-entrega.usecase.js";

const addressFields = {
  label: z.string().optional(),
  // Só o tipo aqui: o formato do CEP é validado no normalizeCep (usecase),
  // junto com a rota do balcão. Regex no zod rejeitaria o CEP sem máscara
  // aqui e a aceitaria em POST /customers/:id/addresses — dois jeitos de
  // validar o mesmo dado.
  cep: z.string().optional(),
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
        selectedVariations: z.record(z.string(), z.string().or(z.array(z.string()))).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
  paymentMethodIntent: z.enum(["cash", "card", "pix", "other"]),
});

const cancelOrderSchema = z.object({
  correlationId: z.string(),
  // Segurança: o endpoint é público — o telefone é o dono do pedido (match
  // com customer.phone); o UUID sozinho não autoriza.
  customerPhone: z.string().min(1),
});

const activeOrderSchema = z.object({ phone: z.string().min(1) });

const cartItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  selectedVariations: z.record(z.string(), z.string().or(z.array(z.string()))).optional(),
  notes: z.string().optional(),
});

const saveCartSchema = z.object({
  phone: z.string().min(1),
  items: z.array(cartItemSchema).max(50),
});

const cartQuerySchema = z.object({ phone: z.string().min(1) });

// Sem authMiddleware — endpoints de cliente final, consumidos pela página
// externa (e internamente pelo webhook do WhatsApp, como chamada de função,
// não HTTP — ver 05-delivery-api-contracts.md).
export async function publicRoutes(app: FastifyInstance) {
  async function assertDeliveryEnabled() {
    const s = await getStoreSettingsUsecase();
    if (!s.usesDelivery) throw Errors.deliveryDisabled();
  }

  app.get("/public/menu", async () => {
    await assertDeliveryEnabled();
    return getPublicMenuUsecase();
  });

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
    await assertDeliveryEnabled();
    const result = await withIdempotency("POST /public/orders", body.correlationId, body, async () => {
      const created = await createSelfServiceOrderUsecase(body);
      return { status: 201, body: created };
    });
    return reply.code(result.status).send(result.body);
  });

  // Cancelamento pelo cliente — só o dono (phone match) e só em stage
  // cancelável (antes do entregador sair em rota, ou entrega falhada com
  // pedido aberto). Idempotente via correlationId.
  app.post("/public/orders/:id/cancel", { preHandler: publicWriteRateLimit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cancelOrderSchema.parse(req.body);
    const result = await withIdempotency(`POST /public/orders/${id}/cancel`, body.correlationId, body, async () => {
      const cancelled = await cancelSelfServiceOrderUsecase({ orderId: id, customerPhone: body.customerPhone });
      return { status: 200, body: cancelled };
    });
    return reply.code(result.status).send(result.body);
  });

  // Pedido em andamento pra retomada — cliente que fechou o browser ou
  // voltou depois vê o banner "Ver status" na página (e o bot manda o
  // mesmo link). Superfície de leitura (mesmo modelo de confiança do lookup).
  app.post("/public/orders/active", { preHandler: publicLookupRateLimit }, async (req) => {
    const body = activeOrderSchema.parse(req.body);
    return getActiveSelfServiceOrderByPhoneUsecase(body.phone);
  });

  app.get("/public/orders/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    return getSelfServiceOrderStatusUsecase(id);
  });

  // ---------- Carrinho server-side (continuação do pedido) ----------
  // Rascunho chaveado por telefone — cliente que fechou/reload no meio do
  // checkout reabre o link e continua de onde parou. Sem validação de
  // produto/estoque (rascunho); validação acontece no submit.
  app.get("/public/cart", { preHandler: publicLookupRateLimit }, async (req) => {
    const { phone } = cartQuerySchema.parse(req.query);
    return { items: (await getCustomerCartUsecase(phone)) ?? [] };
  });

  app.put("/public/cart", { preHandler: publicCartRateLimit }, async (req) => {
    const body = saveCartSchema.parse(req.body);
    await saveCustomerCartUsecase(body.phone, body.items);
    return { ok: true };
  });

  app.delete("/public/cart", { preHandler: publicWriteRateLimit }, async (req) => {
    const body = cartQuerySchema.parse(req.body);
    await clearCustomerCartUsecase(body.phone);
    return { ok: true };
  });

  const calcularEntregaSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    itemsTotal: z.number().min(0).optional(),
  });

  app.post("/calcular-entrega", { preHandler: publicWriteRateLimit }, async (req) => {
    const body = calcularEntregaSchema.parse(req.body);
    return calcularEntregaUsecase(body);
  });
}
