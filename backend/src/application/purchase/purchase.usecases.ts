// Compras e fornecedores (migration 0017) — entrada de mercadoria COMO
// DOCUMENTO multi-item. Cada linha vira um movimento `purchase` no ledger com
// unit_cost — evento de valoração do custo médio móvel (replay em
// stock.usecases). Regra do repo: documento + movimentos + sync de média +
// audit + outbox na MESMA transação.
//
// `product.cost_price` é espelhado para a média corrente (display) após cada
// valoração — mesma disciplina do payment_method denormalizado: o ledger é a
// fonte da verdade; a coluna é só leitura conveniente.
//
// batch_no/expiry_date são informativos (rastreio; a baixa é por produto, sem
// FIFO — ver docs/08-estoque-profissional.md).
//
// ONDA financeiro: este arquivo não toca em Drizzle/infra. A leitura/escrita
// passa pelos ports do `TenantSession` (suppliers/purchases/catalog/stock) e
// `audit`/`outbox` saem na MESMA transação do UoW. A régua (validações, ordem
// das operações, payloads) é a do use case original.

import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { PurchaseItemViewRecord, SupplierRecord } from "../ports/repositories.js";
import { applyStockMovement, INVENTORY_ROOM } from "../stock/stock.usecases.js";

export interface PurchaseUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

export interface PurchaseLineInput {
  productId: string;
  quantity: number;
  unitCost: number;
  batchNo?: string | null;
  expiryDate?: string | null;
}

export interface CreatePurchaseInput {
  supplierId?: string | null;
  invoiceNumber?: string | null;
  issuedOn?: string | null;
  note?: string | null;
  items: PurchaseLineInput[];
}

export interface CreateSupplierInput {
  name: string;
  phone?: string | null;
  taxId?: string | null;
}

export interface UpdateSupplierInput {
  name?: string;
  phone?: string | null;
  taxId?: string | null;
  active?: boolean;
}

/** Forma serializada de `supplier` (mesmos campos da linha, sem lógica adicional). */
function serializeSupplier(s: SupplierRecord) {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    taxId: s.taxId,
    active: s.active,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function createPurchaseUsecases(deps: PurchaseUsecasesDeps) {
  // Detalhe da compra (cabeçalho + linhas + média móvel por produto). Usado pela
  // releitura pós-commit do create e pelo `GET /purchases/:id`.
  async function getPurchase(session: TenantSession, id: string) {
    const purchase = await session.purchases.findDetail(id);
    if (!purchase) throw Errors.notFound("Compra");

    const items: PurchaseItemViewRecord[] = await session.purchases.listItems(id);

    // Média móvel por produto envolvido (para a UI mostrar o custo atual)
    const productIds = [...new Set(items.map((i) => i.productId))];
    const averages = await session.stock.averageCosts(productIds);
    const averagesMap: Record<string, number> = {};
    for (const [pid, v] of averages) averagesMap[pid] = v.avg;

    return { ...purchase, items, averages: averagesMap };
  }

  // ---------- GET /purchases/:id ----------
  async function getPurchaseUsecase(id: string) {
    return deps.uow.run(deps.tenant(), (session) => getPurchase(session, id));
  }

  return {
    // ---------- GET /suppliers ----------
    async listSuppliersUsecase(input: { activeOnly?: boolean; limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const page = await session.suppliers.list(input);
        return { data: page.data.map(serializeSupplier), total: page.total };
      });
    },

    // ---------- POST /suppliers ----------
    async createSupplierUsecase(input: CreateSupplierInput, actorId: string) {
      if (!input.name.trim()) throw Errors.validationFailed({ field: "name" });
      return deps.uow.run(deps.tenant(), async (session) => {
        const created = await session.suppliers.create({
          name: input.name.trim(),
          phone: input.phone?.trim() || null,
          taxId: input.taxId?.trim() || null,
        });
        await session.audit.record({
          actorId,
          action: "supplier_created",
          details: { supplierId: created.id, name: created.name },
        });
        return serializeSupplier(created);
      });
    },

    // ---------- PATCH /suppliers/:id ----------
    async updateSupplierUsecase(id: string, input: UpdateSupplierInput, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.suppliers.findById(id);
        if (!existing) throw Errors.notFound("Fornecedor");
        if (input.name !== undefined && !input.name.trim()) throw Errors.validationFailed({ field: "name" });

        const updated = await session.suppliers.update(id, {
          name: input.name !== undefined ? input.name.trim() : existing.name,
          phone: input.phone !== undefined ? input.phone?.trim() || null : existing.phone,
          taxId: input.taxId !== undefined ? input.taxId?.trim() || null : existing.taxId,
          active: input.active ?? existing.active,
        });
        await session.audit.record({
          actorId,
          action: "supplier_updated",
          details: { supplierId: updated.id },
        });
        return serializeSupplier(updated);
      });
    },

    // ---------- POST /purchases ----------
    async createPurchaseUsecase(input: CreatePurchaseInput, actorId: string) {
      if (!input.items.length) throw Errors.validationFailed({ field: "items", reason: "compra sem itens" });

      const purchaseId = await deps.uow.run(deps.tenant(), async (session) => {
        // Valida produtos (existem, ativos e rastreiam estoque) ANTES do documento,
        // para nunca gravar compra sem efeito no ledger.
        for (const line of input.items) {
          if (!Number.isFinite(line.quantity) || line.quantity <= 0)
            throw Errors.validationFailed({ field: "quantity", reason: "quantidade deve ser maior que zero" });
          if (!Number.isFinite(line.unitCost) || line.unitCost < 0)
            throw Errors.validationFailed({ field: "unitCost", reason: "custo deve ser maior ou igual a zero" });
          const product = await session.catalog.findProductForOrdering(line.productId);
          if (!product || !product.active) throw Errors.notFound("Produto");
          if (!product.trackStock) {
            throw Errors.validationFailed({
              field: "productId",
              reason: `${product.name} não controla estoque (habilite o rastreamento no cadastro)`,
            });
          }
        }

        const total = round2(input.items.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
        const purchase = await session.purchases.createDocument({
          supplierId: input.supplierId ?? null,
          invoiceNumber: input.invoiceNumber?.trim() || null,
          issuedOn: input.issuedOn ?? null,
          note: input.note?.trim() || null,
          total,
          actorId,
        });

        const note = purchase.invoiceNumber ? `Entrada nota ${purchase.invoiceNumber}` : "Entrada de compra";
        for (const line of input.items) {
          const item = await session.purchases.insertItem({
            purchaseId: purchase.id,
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            lineTotal: round2(line.quantity * line.unitCost),
            batchNo: line.batchNo?.trim() || null,
            expiryDate: line.expiryDate || null,
            actorId,
          });

          // Movimento no ledger na mesma transação do documento (rollback
          // conjunto). unit_cost = evento de valoração da média móvel.
          await applyStockMovement(session, {
            productId: line.productId,
            type: "purchase",
            quantityDelta: line.quantity,
            unitCost: line.unitCost,
            purchaseItemId: item.id,
            note,
            createdBy: actorId,
          });
        }

        // Espelha o custo médio corrente em product.cost_price (display).
        for (const line of input.items) {
          const avg = await session.stock.movingAverage(line.productId, 0);
          await session.catalog.setCostPrice(line.productId, avg.avg);
          if (avg.avg > 0) {
            await session.outbox.enqueue({
              room: INVENTORY_ROOM,
              type: "purchase.received",
              aggregateId: purchase.id,
              payload: {
                purchaseId: purchase.id,
                productId: line.productId,
                quantity: line.quantity,
                unitCost: line.unitCost,
                averageCost: avg.avg,
              },
            });
          }
        }

        await session.audit.record({
          actorId,
          action: "purchase_received",
          orderId: null,
          details: {
            purchaseId: purchase.id,
            supplierId: input.supplierId ?? null,
            invoiceNumber: purchase.invoiceNumber,
            items: input.items.length,
            total,
          },
        });

        return purchase.id;
      });

      return getPurchaseUsecase(purchaseId);
    },

    // ---------- GET /purchases ----------
    async listPurchasesUsecase(input: { limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), (session) => session.purchases.list(input));
    },

    getPurchaseUsecase,

    // ---------- GET /inventory/value ----------
    // Σ saldo × custo médio por produto; resumo por categoria + total geral.
    async inventoryValuationUsecase(input: {
      search?: string;
      lowOnly?: boolean;
      limit: number;
      offset: number;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // Busca com a régua original (`lower(name) LIKE lower(%term%)`, sem unaccent)
        // implementada em `listValuationProducts`; categoria já vem resolvida.
        const { rows, total } = await session.stock.listValuationProducts({
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        });
        const balances = await session.stock.balances(rows.map((p) => p.productId));
        const averages = await session.stock.averageCosts(rows.map((p) => p.productId));

        const data = rows.map((p) => {
          const quantity = round2(balances.get(p.productId) ?? 0);
          const averageCost = round2(averages.get(p.productId)?.avg ?? p.costPrice);
          return {
            productId: p.productId,
            name: p.name,
            categoryId: p.categoryId,
            categoryName: p.categoryName,
            unit: p.unit,
            quantity,
            averageCost,
            value: round2(quantity * averageCost),
          };
        });

        const filtered = input.lowOnly ? data.filter((d) => d.quantity <= 1e-9) : data;
        const byCategory = new Map<string, { categoryName: string; quantity: number; value: number }>();
        for (const d of filtered) {
          const key = d.categoryName ?? "Sem categoria";
          const cur = byCategory.get(key) ?? { categoryName: key, quantity: 0, value: 0 };
          cur.quantity += d.quantity;
          cur.value = round2(cur.value + d.value);
          byCategory.set(key, cur);
        }
        const totalValue = round2(filtered.reduce((sum, d) => sum + d.value, 0));

        return {
          data: filtered,
          categories: [...byCategory.values()],
          totalValue,
          total,
        };
      });
    },

    // Fonte da verdade do custo médio vigente de um produto (leitura avulsa).
    // `averageCosts` só tem entrada para produto COM movimentos; sem nenhum, cai
    // no custo manual do cadastro — mesma régua do original.
    async averageCostOf(productId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const product = await session.catalog.findProduct(productId);
        if (!product) throw Errors.notFound("Produto");
        const averages = await session.stock.averageCosts([productId]);
        return averages.get(productId)?.avg ?? product.costPrice;
      });
    },
  };
}

export type PurchaseUsecases = ReturnType<typeof createPurchaseUsecases>;

// Reexport de tipo consumido por quem monta o input (rotas/telas).
export type { PurchaseItemViewRecord };
