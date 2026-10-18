/**
 * POST /orders — abre a comanda.
 *
 * Valida mesa (claim atômico), canal e identificação; registra audit e o
 * alerta do sino na MESMA transação da abertura, e devolve o detalhe
 * serializado.
 */
import { Errors } from "../../../domain/errors.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { serializeOrder } from "../shared/order-serializer.js";
import {
  createAlert,
  describeOrderAlert,
  ORDER_ALERT_KIND,
  ORDER_ALERT_AUDIENCE,
} from "../../alert/alert.usecases.js";

export type OpenOrderInput = {
  waiterId: string;
  tableId?: string;
  customerId?: string;
  tabLabel?: string;
  channel?: "balcao" | "web" | "whatsapp"; // default "balcao" — self-service usa web ou WhatsApp
  deliveryFee?: number; // snapshot da taxa no momento do pedido, só para channel != "balcao"
  externalRef?: string; // referência externa opcional (id do pedido na origem)
  notes?: string;
};

export class OpenOrderUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: OpenOrderInput): Promise<Awaited<ReturnType<typeof serializeOrder>>> {
    if (!input.tableId && !input.customerId && !input.tabLabel) {
      throw Errors.identificationRequired();
    }

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      // 1.6 — valida a mesa antes de abrir: inexistente → 404; ocupada → 409.
      // Só vale para abertura física de comanda (channel default "balcao");
      // self-service não parametriza mesa.
      //
      // No Postgres o "ler status e depois gravar" NÃO é atômico. Por isso a
      // ocupação é um UPDATE condicional: o `status = 'free'` é reavaliado sob o
      // lock de linha, então só uma transação consegue mudar free -> occupied.
      if (input.tableId) {
        const claimed = await session.catalog.tryClaimTable(input.tableId);
        if (!claimed) {
          // Nenhuma linha alterada: ou a mesa não existe, ou já está ocupada.
          // Uma leitura só aqui (o caminho feliz não paga essa query) decide
          // entre 404 e 409 sem reintroduzir a corrida.
          const table = await session.catalog.findTable(input.tableId);
          if (!table) throw Errors.tableNotFound(input.tableId);
          throw Errors.tableOccupied();
        }
      }

      const created = await session.orders.open({
        waiterId: input.waiterId,
        tableId: input.tableId ?? null,
        customerId: input.customerId ?? null,
        tabLabel: input.tabLabel ?? null,
        channel: input.channel ?? "balcao",
        deliveryFee: input.deliveryFee ?? null,
        externalRef: input.externalRef ?? null,
        notes: input.notes ?? null,
      });

      if (input.tableId) {
        await session.outbox.enqueue({
          room: `table:${input.tableId}`,
          type: "table.status_changed",
          aggregateId: input.tableId,
          payload: { tableId: input.tableId, status: "occupied" },
        });
      }

      await session.audit.record({
        actorId: input.waiterId,
        action: "order_opened",
        orderId: created.id,
        // Chaves ausentes no input são omitidas EXATAMENTE como o
        // JSON.stringify do `logAction` antigo omitia (undefined some, null fica).
        details: {
          ...(input.tableId !== undefined ? { tableId: input.tableId } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
          ...(input.tabLabel !== undefined ? { tabLabel: input.tabLabel } : {}),
        },
      });

      // Alerta do sino (baseline 0001). Fica AQUI, e não em cada canal, porque os
      // canais passam por esta função: balcão (`POST /orders`), self-service
      // (order-intake) e qualquer canal novo. Se ficasse em cada
      // chamador, um canal novo nasceria mudo.
      //
      // O texto precisa do número da mesa / nome do cliente, que a linha do
      // pedido não traz (só os ids) — por isso as duas leituras abaixo. São
      // leituras por PK dentro de uma transação que já fez UPDATE condicional +
      // INSERT + audit, então o custo é desprezível e o ganho (alerta legível
      // "Nova comanda · Mesa 3") é todo para quem lê.
      const channel = input.channel ?? "balcao";
      const [table, customer] = await Promise.all([
        input.tableId ? session.catalog.findTable(input.tableId) : null,
        input.customerId ? session.customers.findById(input.customerId) : null,
      ]);
      const { title, body } = describeOrderAlert({
        channel,
        // Para mesa, o rótulo é o número da pessoa — um id de mesa no alerta
        // seria inútil. Sem mesa (pub/cliente), o tabLabel é o rótulo de verdade.
        label: input.tableId ? (table?.number ? `Mesa ${table.number}` : "Mesa") : input.tabLabel,
        customerName: customer?.name,
      });
      await createAlert(session, {
        kind: ORDER_ALERT_KIND,
        title,
        body,
        orderId: created.id,
        channel,
        audience: ORDER_ALERT_AUDIENCE,
      });

      return serializeOrder(session, created.id);
    });
  }
}
