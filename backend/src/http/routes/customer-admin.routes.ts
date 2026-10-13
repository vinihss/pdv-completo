/**
 * Rotas administrativas de endereços de cliente (adicionar / definir padrão /
 * excluir). Os endpoints de cliente em si estão em `customer.routes.ts`.
 *
 * Endpoints:
 *   POST   /customers/:id/addresses                     — adicionar endereço (manager, cashier)
 *   POST   /customers/:id/addresses/:addressId/default  — marcar padrão (manager, cashier)
 *   DELETE /customers/:id/addresses/:addressId          — remover endereço (manager, cashier)
 *
 * Use cases: `backend/src/application/self-service/customer-address.usecases.ts`
 */
import type { CustomerRoutesDeps } from "../../composition/routes-deps.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
const addressCreateSchema = z.object({
  label: z.string().optional().nullable(),
  cep: z.string().optional().nullable(),
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional().nullable(),
  neighborhood: z.string().min(1),
  city: z.string().min(1),
  // UF (baseline 0001) — a rota pública de endereço já aceitava e devolvia; o cadastro
  // manual ficava sem o campo, então o mesmo cliente saía com UF ou sem
  // dependendo de qual tela o cadastrou.
  state: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  isDefault: z.boolean().optional(),
});

export interface CustomerRouteOptions { deps: CustomerRoutesDeps }

export async function customerAdminRoutes(app: FastifyInstance, options: CustomerRouteOptions) {
  const {
    addCustomerAddressUsecase,
    setDefaultCustomerAddressUsecase,
    deleteCustomerAddressUsecase,
  } = options.deps;

  app.addHook("preHandler", authMiddleware);

  // ---------- Customers — endereços (manutenção) ----------
  app.post("/customers/:id/addresses", { preHandler: requireRole("manager", "cashier") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = addressCreateSchema.parse(req.body);
    const created = await addCustomerAddressUsecase({ customerId: id, ...body });
    return reply.code(201).send(created);
  });
  app.post("/customers/:id/addresses/:addressId/default", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id, addressId } = req.params as { id: string; addressId: string };
    return setDefaultCustomerAddressUsecase(id, addressId);
  });
  app.delete("/customers/:id/addresses/:addressId", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id, addressId } = req.params as { id: string; addressId: string };
    return deleteCustomerAddressUsecase(id, addressId);
  });
}
