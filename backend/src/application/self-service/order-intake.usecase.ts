// Checkout self-service e acompanhamento do cliente — ONDA 3 da refatoração
// arquitetural.
//
// Este arquivo é uma FACTORY pura (`createOrderIntakeUsecases(deps)`): nenhuma
// importação de infra/integrations/config nem Drizzle. Toda persistência passa
// pelo `uow.run`/`session.*`; a composição com o hub de pedidos (abrir comanda,
// lançar itens, registrar a intenção de pagamento, ler a comanda) chega
// INJETADA pela composition root — a application não importa infra. O efeito
// `customer.stage_changed` entra na mesma transação via
// `emitCustomerStageChanged`.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2/3): as leituras que antes rodavam
// "fora do tx" (catálogo de variações, cliente, endereço salvo, entrega,
// settings) passam a rodar dentro de um `uow.run`. Sob READ COMMITTED o
// resultado é o mesmo (snapshot por statement); o ganho é um caminho só para
// ler e escrever, sem meio-commit. As chamadas às use cases injetadas
// (`openOrder`/`addItems`/`registerPayment`) continuam cada uma com sua PRÓPRIA
// transação — passos atômicos em sequência, exatamente como o fluxo de garçom
// (`POST /orders` e `POST /orders/:id/items`) já era.
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { round2 } from "../../domain/money.js";
import { deriveCustomerStage, stageTimeline, CUSTOMER_STAGES } from "../../domain/customer-order-state.js";
import { estimateDeliveryMinutes, estimateWindow } from "../../domain/delivery-eta.js";
import { parseVariations, missingRequiredGroups, unknownOptions } from "../../domain/variations.js";
import { parseTiers, type DeliveryFeeTier } from "../delivery/delivery-pricing.usecase.js";
import { emitCustomerStageChanged } from "./customer-stage.js";
import { formatAddress, type CustomerAddressUsecases } from "./customer-address.usecases.js";
import type { OrderUsecases } from "../order/order.usecases.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { StoreSettingsReader } from "../ports/effects.js";
import type { DeliveryRecord } from "../ports/repositories.js";

const DELIVERY_ROOM = "deliveries"; // painel do manager e listagem do entregador escutam aqui

/**
 * Valida a faixa escolhida contra a tabela real da loja.
 *
 * O cliente manda `maxKm` como número solto no corpo do pedido, então o valor
 * é dado do cliente até que a tabela diga o contrário. Aceitar qualquer número
 * deixaria a viagem estimada sem teto (minutos_per_km × 999999) ou, no outro
 * extremo, sem piso — e a estimativa é o que o salão promete. unknown → null,
 * que o cálculo trata como "só o piso de viagem".
 */
function resolveZoneKm(requested: number | null | undefined, tiers: DeliveryFeeTier[]): number | null {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) return null;
  const match = tiers.find((t) => t.maxKm === requested);
  return match ? match.maxKm : null;
}

type IntakeLine = {
  productId: string;
  quantity: number;
  selectedVariations?: Record<string, string | string[]>;
  notes?: string;
};

// Confere cada linha contra os grupos de variação do produto. Produto
// inexistente fica pra `addItems` responder com o erro dele (404) — aqui só
// filtramos o que dá pra validar. Lê o catálogo pela sessão (uma query em lote).
async function assertVariationsSelectable(session: TenantSession, lines: IntakeLine[]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  if (ids.length === 0) return;
  const rows = await session.catalog.findProductsByIds(ids);
  const byId = new Map(rows.map((p) => [p.id, p]));

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) continue;
    const groups = parseVariations(product.variations);

    const missing = missingRequiredGroups(groups, line.selectedVariations);
    if (missing.length > 0) throw Errors.variationRequired(product.name, missing);

    const unknown = unknownOptions(groups, line.selectedVariations);
    if (unknown.length > 0) {
      throw Errors.variationInvalid(product.name, unknown[0].group, unknown[0].option);
    }
  }
}

/**
 * Bloco de previsão que a tela de acompanhamento usa, recalculado a cada poll.
 *
 * A estimativa gravada no pedido é uma foto do momento da criação e vale para a
 * janela INTEIRA (preparo + viagem) enquanto o pedido está na cozinha. Quando o
 * entregador sai (`dispatchedAt`), a cozinha já cumpriu a parte dela e o que
 * sobra é o trajeto — a partir daí a previsão vira contagem a partir do
 * horário real de saída, que é mais honesto do que somar minutos numa base
 * antiga. É a diferença entre "38 min" ditado no pedido e "chega até 19:52"
 * depois que o motoboy pegou a encomenda.
 *
 * `remainingMinutes` é null enquanto o pedido não saiu: sem `dispatched_at` não
 * há base para contar, e devolver a estimativa inteira seria mentir sobre o que
 * falta.
 */
function etaForStage(
  delivery: Pick<DeliveryRecord, "estimatedMinutes" | "dispatchedAt"> | null | undefined,
  stage: string,
  prepMinutes: number,
  minutesPerKm: number
) {
  const estimatedMinutes = delivery?.estimatedMinutes ?? estimateDeliveryMinutes({ maxKm: null, prepMinutes, minutesPerKm });
  const eta = { estimatedMinutes, estimatedWindow: estimateWindow(estimatedMinutes) };

  const dispatchedAt = delivery?.dispatchedAt;
  if (stage !== "out_for_delivery" || !dispatchedAt) {
    return { ...eta, remainingMinutes: null as number | null };
  }

  // Tempo só de viagem: o preparo já foi consumido até o despacho.
  const travel = Math.max(0, estimatedMinutes - prepMinutes);
  const at = Date.parse(dispatchedAt);
  if (Number.isNaN(at)) return { ...eta, remainingMinutes: null as number | null };

  const remainingMinutes = Math.max(0, Math.round((at + travel * 60_000 - Date.now()) / 60_000));
  const window = estimateWindow(travel);
  return {
    ...eta,
    remainingMinutes,
    // Fim da janela de chegada, em ISO — a tela formata no fuso do cliente.
    deliverBy: new Date(at + window.max * 60_000).toISOString(),
  };
}

// ---------- factory ----------

export interface OrderIntakeUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  settings: StoreSettingsReader;
  /** `addCustomerAddressUsecase` do hub de endereços (aplica limite/padrão). */
  addCustomerAddress: CustomerAddressUsecases["addCustomerAddressUsecase"];
  /** `openOrderUsecase` do hub de pedidos (já ligado às deps dele). */
  openOrder: OrderUsecases["openOrderUsecase"];
  /** `addItemsUsecase` do hub de pedidos (já ligado às deps dele). */
  addItems: OrderUsecases["addItemsUsecase"];
  /** `registerPaymentUsecase` do hub de pedidos (já ligado às deps dele). */
  registerPayment: OrderUsecases["registerPaymentUsecase"];
  /** `getOrderUsecase` do hub de pedidos (leitura da comanda serializada). */
  getOrder: OrderUsecases["getOrderUsecase"];
}

/**
 * Checkout e acompanhamento do self-service sobre o Unit-of-Worker, com as
 * MESMAS assinaturas de antes (sem o `deps`). Os nomes legados são
 * re-exportados por `infra/composition/default-usecases.ts`.
 */
export function createOrderIntakeUsecases(deps: OrderIntakeUsecasesDeps) {
  return {
    /**
     * Ponto único de checkout self-service (§04 "Decisões de arquitetura" —
     * "Checkout é uma função compartilhada, não duplicada por canal"). A rota
     * pública da página chama esta função diretamente, nunca reimplementa a
     * lógica de resolver cliente/endereço ou criar o pedido.
     */
    async createSelfServiceOrderUsecase(input: {
      channel: "web";
      customerPhone: string;
      customerName: string;
      addressId?: string;
      newAddress?: {
        label?: string;
        cep?: string;
        street: string;
        number: string;
        complement?: string;
        neighborhood: string;
        city: string;
        reference?: string;
        isDefault?: boolean;
      };
      items: Array<{
        productId: string;
        quantity: number;
        selectedVariations?: Record<string, string | string[]>;
        notes?: string;
      }>;
      paymentMethodIntent: "cash" | "card" | "pix" | "other";
      notes?: string;
      /**
       * `maxKm` da faixa de distância que o cliente marcou na tela de endereço.
       * Entra só na estimativa (ver domain/delivery-eta.ts) — o FRETE continua
       * vindo de `store_settings.delivery_fee` aqui, como no §04; trocar a taxa por
       * faixa no checkout é outra conversa e mexeria no total que o cliente
       * confirma. Ausente ou fora das faixas: o tempo de viagem usa só o piso.
       */
      deliveryZoneKm?: number | null;
      cashReceived?: string;
    }) {
      if (!input.addressId && !input.newAddress) {
        throw Errors.validationFailed({ field: "addressId|newAddress", reason: "informe um endereço" });
      }

      // 0-2. Variações + cliente + endereço salvo, numa janela só: lê o
      // catálogo de variações e o cliente por telefone (chave de identificação
      // nos dois canais) e grava o cliente novo. A guarda de variação roda
      // ANTES de qualquer INSERT e o `throw` aborta a transação.
      const resolved = await deps.uow.run(deps.tenant(), async (session) => {
        // 0. Variações — valida ANTES de qualquer escrita. `addItems` grava
        // `selectedVariations` como veio, sem conferir contra o catálogo: sem
        // esta guarda, um X-Burger sem "Ponto da carne" (grupo obrigatório)
        // viraria pedido e a cozinha receberia algo impossível de produzir.
        // Erro 422 com o grupo faltante, pra tela apontar o que resolver.
        await assertVariationsSelectable(session, input.items);

        let customer = await session.customers.findByPhone(input.customerPhone);
        if (!customer) {
          customer = await session.customers.save({ name: input.customerName, phone: input.customerPhone });
        }

        // 2. Resolve o endereço SALVO (o novo é criado fora daqui, pelo use
        // case dedicado que abre a própria transação).
        let addressText: string | null = null;
        if (input.addressId) {
          const address = await session.customerAddresses.findById(input.addressId);
          if (!address || address.customerId !== customer.id) throw Errors.notFound("Endereço");
          addressText = formatAddress(address);
        }
        return { customerId: customer.id, addressText };
      });

      // Endereço novo: use case dedicado (aplica o limite de 3 via
      // addCustomerAddressUsecase), com a PRÓPRIA transação — por isso fora do
      // `uow.run` acima.
      let addressText: string;
      if (resolved.addressText !== null) {
        addressText = resolved.addressText;
      } else {
        const created = await deps.addCustomerAddress({ customerId: resolved.customerId, ...input.newAddress! });
        addressText = formatAddress(created);
      }

      // 3. Taxa de entrega — snapshot da configuração atual, gravado no pedido (§04 "Taxa de entrega").
      const settings = await deps.settings.get();

      // 4. Cria o pedido reaproveitando as mesmas usecases do garçom — só muda quem abre (SYSTEM_USER_ID) e o channel.
      const order = await deps.openOrder({
        waiterId: SYSTEM_USER_ID,
        customerId: resolved.customerId,
        tabLabel: `Delivery - ${input.customerName}`,
        channel: input.channel,
        deliveryFee: settings.deliveryFee,
        notes: input.notes,
      });

      const items = await deps.addItems({
        orderId: order.id,
        userId: SYSTEM_USER_ID,
        items: input.items,
      });

      // Sem isso, closeOrderUsecase rejeitaria o fechamento por
      // "payment_not_registered" quando a entrega for confirmada (ver
      // deliverDeliveryUsecase). confirmed:false porque é só a intenção
      // declarada no checkout — a confirmação de verdade acontece quando o
      // entregador recebe o pagamento, na entrega. Respeita
      // store_settings.enabledPaymentMethods (mesma validação que o balcão já
      // usa) — se o gerente desabilitou "pix", por exemplo, o checkout falha
      // aqui com o erro correto em vez de criar um pedido que não vai fechar.
      //
      // Dinheiro: o cliente pode dizer quanto vai entregar na mão, para o
      // entregador levar o troco certo. A conversão de "50,00" (o que a tela
      // manda) para número acontece aqui; a validação contra o total fica em
      // upsertPaymentLines (received < amount é erro). Vazio vira undefined —
      // pagamento exato não precisa de `received`.
      let cashReceivedNum: number | undefined;
      if (input.paymentMethodIntent === "cash" && input.cashReceived?.trim()) {
        const normalized = input.cashReceived.replace(/\./g, "").replace(",", ".");
        const v = Number(normalized);
        if (Number.isFinite(v) && v >= 0) {
          cashReceivedNum = v;
        }
      }

      await deps.registerPayment({
        orderId: order.id,
        userId: SYSTEM_USER_ID,
        paymentMethod: input.paymentMethodIntent,
        confirmed: false,
        received: cashReceivedNum,
      });

      // 4.1 Previsão de entrega — calculada ANTES da transação da entrega
      // porque `distance_km` e `estimated_minutes` são gravados no insert
      // (domain/delivery-eta.ts). O que o cliente escolheu na tela é validado
      // contra as faixas reais da loja: um `maxKm` forjado pelo cliente
      // cortaria a viagem estimada pela metade e o balcão receberia uma
      // promessa que não pode cumprir.
      const tiers = parseTiers(settings.deliveryFeeTiers);
      const zoneKm = resolveZoneKm(input.deliveryZoneKm, tiers);
      const estimatedMinutes = estimateDeliveryMinutes({
        maxKm: zoneKm,
        prepMinutes: settings.deliveryPrepMinutes,
        minutesPerKm: settings.minutesPerKm,
      });

      // 5. Cria a entrega já no momento do pedido — não é preciso esperar a
      // cozinha pra o manager já poder planejar/atribuir entregador (correção
      // sobre o desenho original do §04, que sugeria criar isso só quando os
      // itens ficassem "ready"; o endereço já está resolvido aqui, então não há
      // motivo pra adiar, e adiar exigiria guardar o endereço em algum lugar
      // intermediário).
      const delivery = await deps.uow.run(deps.tenant(), async (session) => {
        const created = await session.deliveries.create({
          orderId: order.id,
          address: addressText,
          status: "awaiting_courier",
          distanceKm: zoneKm,
          estimatedMinutes,
        });

        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.created",
          aggregateId: created.id,
          payload: { deliveryId: created.id, orderId: order.id },
        });
        // Stage inicial "received" — o WS público (retomada por ?order=<id>) e
        // o polling do cliente partem do estado canônico da máquina.
        await emitCustomerStageChanged(session, order.id);
        await session.audit.record({
          actorId: SYSTEM_USER_ID,
          action: "delivery_created",
          orderId: order.id,
          details: { channel: input.channel, addressText },
        });

        return created;
      });

      const itemsTotal = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
      const total = itemsTotal + (settings.deliveryFee ?? 0);

      return {
        orderId: order.id,
        deliveryId: delivery.id,
        total,
        deliveryFee: settings.deliveryFee,
        // Previsão real (preparo + viagem pela faixa escolhida). A tela abre
        // ±20% em volta — a janela, não este ponto, é o que vai pro cliente.
        estimatedMinutes,
        estimatedWindow: estimateWindow(estimatedMinutes),
      };
    },

    /**
     * Status público do pedido pra o cliente — inclui o estado canônico da
     * máquina (customer-order-state.ts) além dos eixos brutos (mantidos pra
     * compat do polling). total/estimatedMinutes alimentam a retomada por
     * ?order=<id> (o orderId é a "senha" de fato — já era visível hoje).
     */
    async getSelfServiceOrderStatusUsecase(orderId: string) {
      const order = await deps.getOrder(orderId);
      const { delivery, settings } = await deps.uow.run(deps.tenant(), async (session) => ({
        delivery: await session.deliveries.findByOrder(orderId),
        settings: await deps.settings.get(),
      }));

      const stage = deriveCustomerStage(
        { status: order.status },
        order.items.map((i) => ({ status: i.status })),
        delivery ? { status: delivery.status } : null
      );
      const meta = CUSTOMER_STAGES[stage];
      const total = round2(
        order.items
          .filter((i) => i.status !== "cancelled")
          .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) + (order.deliveryFee ?? 0)
      );

      return {
        orderStatus: order.status,
        itemsStatus: order.items.map((i) => ({ id: i.id, status: i.status })),
        deliveryStatus: delivery?.status ?? null,
        customerStage: { stage, label: meta.label, terminal: meta.terminal },
        timeline: stageTimeline(stage),
        total,
        ...etaForStage(delivery, stage, settings.deliveryPrepMinutes, settings.minutesPerKm),
      };
    },

    /**
     * Pedido em andamento pra retomada — cliente que fechou o browser ou
     * voltou depois vê "Você tem um pedido em andamento".
     * Andamento = orders.status "open" (não fechado/cancelado) do canal
     * self-service; o stage pode ser terminal-fracassado ("failed") — o
     * cliente precisa ver isso também pra poder cancelar ou reordenar.
     */
    async getActiveSelfServiceOrderByPhoneUsecase(phone: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findByPhone(phone);
        if (!customer) return null;

        // `whatsapp` entra na lista só por compatibilidade de leitura: pedidos
        // antigos feitos pelo canal que não existe mais continuam tendo dono, e
        // escondê-los deixaria o cliente sem o "pedido em andamento".
        const active = await session.orders.findLatestOpenByCustomer(customer.id, ["whatsapp", "web"]);
        if (!active) return null;

        const items = await session.orders.listItemRows(active.id);
        const delivery = await session.deliveries.findByOrder(active.id);
        const settings = await deps.settings.get();

        const stage = deriveCustomerStage(
          { status: active.status },
          items.map((i) => ({ status: i.status })),
          delivery ? { status: delivery.status } : null
        );
        const meta = CUSTOMER_STAGES[stage];
        const total = round2(
          items
            .filter((i) => i.status !== "cancelled")
            .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) + (active.deliveryFee ?? 0)
        );

        return {
          orderId: active.id,
          customerStage: { stage, label: meta.label, terminal: meta.terminal },
          total,
          // Mesma janela do endpoint de status: quem chega pela retomada precisa
          // ver a previsão que o cliente original recebeu, não um número diferente.
          ...etaForStage(delivery, stage, settings.deliveryPrepMinutes, settings.minutesPerKm),
          openedAt: active.openedAt,
        };
      });
    },
  };
}

export type OrderIntakeUsecases = ReturnType<typeof createOrderIntakeUsecases>;
