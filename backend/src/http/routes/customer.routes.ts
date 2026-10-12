/**
 * Rotas administrativas de clientes: busca, CRUD, histórico, resumo e foto.
 * (Os endereços estão em `customer-admin.routes.ts`.)
 *
 * Endpoints:
 *   GET    /customers/search        — busca leve (manager, cashier, waiter)
 *   GET    /customers               — lista paginada (manager, cashier)
 *   GET    /customers/:id           — detalhe + endereços + comandas abertas (manager, cashier)
 *   GET    /customers/:id/orders    — histórico de comandas paginado (manager, cashier)
 *   GET    /customers/:id/summary   — consumo por dia para o gráfico (manager, cashier)
 *   POST   /customers               — criar cliente (manager, cashier, waiter)
 *   PATCH  /customers/:id           — editar/soft-delete/reativar (manager, cashier)
 *   POST   /customers/:id/photo     — upload de foto (manager, cashier)
 *   DELETE /customers/:id/photo     — remover foto (manager, cashier)
 *
 * Use cases: `backend/src/application/` (customer)
 * Testes: `backend/test/` (team-customers, profiles)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listCustomersUsecase,
  getCustomerDetailUsecase,
  createCustomerUsecase,
  updateCustomerUsecase,
  searchCustomersUsecase,
  saveCustomerPhotoUsecase,
  clearCustomerPhotoUsecase,
  listCustomerOrdersUsecase,
  customerSummaryUsecase,
} from "../../application/customer.usecases.js";
import { imageExtByMime } from "./image-ext.js";

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  // CPF e observações (baseline 0001). Válidos como string aqui e normalizados no
  // usecase: quem manda é o cliente_http, e o arquivo do CPF pode vir com
  // máscara ("529.982.247-25") — o backend guarda os 11 dígitos crus.
  cpf: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
const customerUpdateSchema = customerSchema.partial().extend({ active: z.boolean().optional() });

export async function customerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Customers ----------
  // Busca leve do garçom (abrir comanda com cliente): só ativos, sem email —
  // a manutenção completa é a rota paginada abaixo, restrita a gerente/caixa.
  app.get("/customers/search", { preHandler: requireRole("manager", "cashier", "waiter") }, async (req) => {
    const q = (req.query as { q?: string }).q;
    return searchCustomersUsecase(q);
  });
  app.get("/customers", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const q = req.query as { search?: string; active?: string; limit?: string; offset?: string };
    return listCustomersUsecase({
      search: q.search,
      active: q.active !== undefined ? q.active === "true" : undefined,
      limit: Math.min(Number(q.limit ?? 100), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  app.get("/customers/:id", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    return getCustomerDetailUsecase(id);
  });
  // Histórico de comandas do cliente — paginado, mais recente primeiro (com a
  // comanda em aberto por último: `closed_at NULLS LAST` no usecase).
  // `from`/`to` (YYYY-MM-DD) são opcionais e existem para o drill-down do dia
  // no gráfico; sem eles vem o histórico inteiro. O `total` é sempre do
  // conjunto filtrado, não da página.
  app.get("/customers/:id/orders", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; offset?: string; from?: string; to?: string; tz?: string };
    return listCustomerOrdersUsecase(id, {
      limit: Math.min(Number(q.limit ?? 20), 100),
      offset: Number(q.offset ?? 0),
      from: q.from,
      to: q.to,
      tz: q.tz,
    });
  });
  // Série de consumo por dia para o gráfico. `days` tem default 30 e é
  // limitado a 365 dentro do usecase (o teto é decisão de domínio, e o
  // parâmetro também chega por URL). `tz` é o offset do fuso da loja
  // ("-03:00"), igual ao da visão geral — sem ele o dia vira UTC.
  app.get("/customers/:id/summary", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { days?: string; tz?: string };
    return customerSummaryUsecase(id, { days: q.days !== undefined ? Number(q.days) : undefined, tz: q.tz });
  });
  // Criar cliente é operação de balcão (garçom abre comanda com cliente);
  // editar/endereços seguem restritos a gerente/caixa.
  app.post("/customers", { preHandler: requireRole("manager", "cashier", "waiter") }, async (req, reply) => {
    const body = customerSchema.parse(req.body);
    const created = await createCustomerUsecase(body, req.authUser!.sub);
    return reply.code(201).send(created);
  });
  app.patch("/customers/:id", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = customerUpdateSchema.parse(req.body);
    return updateCustomerUsecase(id, body, req.authUser!.sub);
  });
  // Foto do cliente — upload multipart (multipart/form-data, campo "photo").
  // Mesmo desenho de `/users/:id/photo`: nome de arquivo gerado pelo app,
  // JPEG/PNG/WebP pelos limites do `@fastify/multipart` (2 MB, 1 arquivo).
  app.post("/customers/:id/photo", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "photo" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "photo" });
    const buffer = await file.toBuffer();
    return saveCustomerPhotoUsecase(id, { buffer, ext }, req.authUser!.sub);
  });
  // Foto do cliente — remover
  app.delete("/customers/:id/photo", { preHandler: requireRole("manager", "cashier") }, async (req) => {
    const { id } = req.params as { id: string };
    return clearCustomerPhotoUsecase(id, req.authUser!.sub);
  });
}
