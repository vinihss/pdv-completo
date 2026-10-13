// Central de alertas (migration 0004): o que chega no salão (hoje, a abertura
// de uma comanda) e o estado de "não visualizado".
//
// Por que uma tabela, e não só o `outbox_event`: o outbox é descarte - a linha
// é marcada como publicada e some depois de 1h de manutenção. O sino precisa
// sobreviver a um F5 com o tablet deitado na mesa, e precisa de um contador
// que o backend seja dono (o app é server-authoritative: sem lib de estado, e
// o contador de uma tela desenhada pela casca não pode morar na página).
//
// Duas metades que precisam concordar:
//   - REST   `GET /alerts` filtra por audiência (o papel e/ou o usuário que
//             perguntam);
//   - WS     `enqueueEvent` publica em `alerts` / `alerts:<role>` /
//             `alerts:user:<id>`, e o `canJoinRoom` só autoriza o room do
//             PRÓPRIO papel e o do PRÓPRIO usuário. Os dois lados usam a mesma
//             audiência - é o fan-out que impede o alerta de vazar para quem não
//             deveria ouvir (ex.: o garçom, que abriu a comanda e já está olhando
//             para ela).
//
// `read_at` é global, não por usuário: a pergunta é "alguém do salão já viu
// isso?" e quem responde é a tela da comanda. Não gera linha de audit_log -
// o evento de domínio (`order_opened`) já está auditado em openOrderUsecase;
// o alerta é só a projeção dele na beirada.
//
// ONDA 2: este arquivo não toca em Drizzle/infra. `createAlert` recebe o
// `TenantSession` (repositório de alertas + outbox NA MESMA transação da
// escrita de domínio) e a factory `createAlertUsecases` monta as use cases de
// leitura/marcação sobre o Unit-of-Worker. As funções PURAS (describe*,
// rooms, constants) continuam exports diretos — é o que a suíte consome.
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { AlertRecord } from "../ports/repositories.js";

/** Room público: alerta sem restrição de público. */
export const ALERTS_ROOM = "alerts";
/** Room por papel - o cliente assina `alerts` + `alerts:<seu papel>`. */
export function alertsRoomFor(role: string) {
  return `${ALERTS_ROOM}:${role}`;
}

/**
 * Audiência INDIVIDUAL: alerta que é de uma pessoa só (o entregador X recebeu a
 * entrega Y), e não de um papel. O token viaja no mesmo `audience_roles` (que é
 * TEXT[]) com o prefixo `user:`, então é a MESMA coluna e o MESMO predicado
 * que já filtram por papel - nenhum schema novo, nenhuma migration.
 *
 * A alternativa era um room `alerts:courier` + filtro no cliente, que foi
 * descartada: o room por papel é compartilhado por todos os entregadores, então
 * todo mundo ouviria o mesmo `alert.created` e a fila de "quem é meu" passaria
 * a depender de o cliente filtrar - com o sino já tocando antes disso. E
 * adicionar `courier` à audiência global (`ORDER_ALERT_AUDIENCE`) era
 * exatamente o que não pode: tocaria o sino de TODOS os entregadores a cada
 * pedido que caísse, mesmo os que não são dele.
 *
 * O room pessoal entra no handshake (ver realtime.routes.ts), então o cliente
 * atual - que só assina `alerts` + `alerts:<papel>` e reage a qualquer
 * `alert.created` - passa a receber o alerta direcionado sem mudar uma linha.
 */
export function alertUserToken(userId: string) {
  return `user:${userId}`;
}

/** Room privado de um usuário - o par de `alertUserToken` no realtime. */
export function alertsUserRoomFor(userId: string) {
  return `${ALERTS_ROOM}:${alertUserToken(userId)}`;
}

export const ORDER_ALERT_KIND = "order_created";

/**
 * Kind do alerta direcionado da atribuição: "essa entrega agora é SUA".
 * Distinto de `order_created` de propósito - é o que permite o sino (e o
 * cliente) separar "pedido novo no salão" de "você recebeu trabalho".
 */
export const DELIVERY_ASSIGNED_ALERT_KIND = "delivery_assigned";

/**
 * Quem ouve "chegou comanda". O gerente (acompanha tudo), o caixa (precisa
 * saber o que está entrando) e a cozinha (começa a produção). O garçom não entra
 * aqui de propósito: em comanda de balcão ele é quem abriu, e um alerta do
 * próprio lançamento seria ruído.
 */
export const ORDER_ALERT_AUDIENCE = ["manager", "cashier", "kitchen"] as const;

const CHANNEL_LABEL: Record<string, string> = {
  balcao: "Balcão",
  web: "página",
  ifood: "iFood",
};

/**
 * Texto do alerta de comanda. Função pura de propósito: quem chama (a
 * self-service, o iFood e o balcão passam pelo mesmo `openOrderUsecase`) monta
 * o `label` e o `customerName`, e aqui a frase é decidida uma vez só - é o que
 * a suíte testa sem precisar de banco.
 *
 *   balcão  -> "Nova comanda · Mesa 3"   / corpo "Balcão"
 *   web     -> "Novo pedido de Ana"      / corpo "Entrega · página"
 *   ifood   -> "Novo pedido do iFood"    / corpo "iFood 1234"
 */
export function describeOrderAlert(input: {
  channel: "balcao" | "web" | "ifood";
  /** "Mesa 3" (mesa) ou o tabLabel da comanda ("Delivery - Ana", "iFood 99"). */
  label?: string | null;
  customerName?: string | null;
}): { title: string; body: string } {
  const label = input.label?.trim() || null;
  const channel = CHANNEL_LABEL[input.channel] ?? input.channel;

  if (input.channel === "ifood") {
    return { title: `Novo pedido do ${channel}`, body: label ?? "" };
  }
  if (input.channel === "web") {
    const who = input.customerName?.trim() || label;
    return {
      title: who ? `Novo pedido de ${who}` : `Novo pedido de entrega`,
      body: `Entrega · ${channel}`,
    };
  }
  return { title: label ? `Nova comanda · ${label}` : "Nova comanda", body: channel };
}

/**
 * Texto do alerta de atribuição. Função pura pelo mesmo motivo da outra: a
 * frase é decidida uma vez, longe do React e do banco, e a suíte fixa o texto
 * sem montar nada.
 *
 * O endereço (e não o nome do cliente) porque é o que o entregador precisa
 * para sair, e porque ele já está no `delivery` - o nome exigiria o join da
 * comanda e do cliente só para enfeitar um sino.
 */
export function describeDeliveryAssignedAlert(input: {
  orderId: string;
  address?: string | null;
}): { title: string; body: string } {
  const ref = input.orderId ? `#${input.orderId.slice(0, 8)}` : "pedido";
  const address = input.address?.trim();
  // O sino mostra o corpo em uma linha: endereço muito longo (rua + bairro +
  // cidade + referência) é cortado, não quebrado em quatro linhas.
  const curto = !address ? "" : address.length > 60 ? `${address.slice(0, 59).trimEnd()}…` : address;
  return { title: "Entrega atribuída a você", body: curto ? `${ref} · ${curto}` : ref };
}

/**
 * Payload do evento `alert.created` (e da leitura REST): o MESMO shape do
 * `serialize` original — `audience_roles` NÃO viaja (é o recorte interno de
 * quem ouve, não o conteúdo do sino).
 */
function serialize(row: AlertRecord, orderStatus?: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    orderId: row.orderId,
    channel: row.channel,
    readAt: row.readAt,
    createdAt: row.createdAt,
    // O evento é enfileirado dentro da transação que ABRE a comanda, então o
    // status aqui é "open" por construção. A listagem por REST, essa sim, traz
    // o status real (a comanda pode ter sido fechada entre o alerta e a leitura).
    orderStatus: orderStatus ?? null,
  };
}

/**
 * Grava o alerta e publica o evento, na MESMA transação da escrita de domínio
 * (regra do repo: audit + outbox no mesmo commit). Chamar de fora de uma
 * transação deixaria o evento e a linha nascerem por caminhos diferentes — o
 * sino tocaria para uma comanda que não chegou a existir.
 *
 * `audience` (papéis) e `userIds` (pessoas) se somam no mesmo `audience_roles`:
 * quem está em qualquer um dos dois recebe. Os dois vazios = alerta público.
 *
 * ONDA 2: era `createAlertTx(tx, ...)`; a sessão carrega `alerts` + `outbox`
 * já ligados à transação corrente (o wrapper `createAlertTx` legado mora em
 * `infra/composition/order-compat.ts`).
 */
export async function createAlert(
  session: TenantSession,
  input: {
    kind?: string;
    title: string;
    body?: string | null;
    orderId?: string | null;
    channel?: string | null;
    /** vazio = só os `userIds` (ou o room público, se não houver nenhum). */
    audience?: readonly string[];
    /** audiência individual — o token `user:<id>` entra em `audience_roles`. */
    userIds?: readonly string[];
  },
): Promise<AlertRecord> {
  const audience = input.audience ?? [];
  const userIds = input.userIds ?? [];
  const row = await session.alerts.create({
    kind: input.kind ?? ORDER_ALERT_KIND,
    title: input.title,
    body: input.body ?? null,
    orderId: input.orderId ?? null,
    channel: input.channel ?? null,
    audienceRoles: [...audience, ...userIds.map(alertUserToken)],
  });

  // Um insert por room: um para cada papel e um para cada pessoa da audiência.
  // Sem papel e sem pessoa, o room único `alerts` (que todo mundo logado
  // assina) evita cinco linhas de outbox para um alerta que é de todo mundo.
  const rooms = [...audience.map(alertsRoomFor), ...userIds.map(alertsUserRoomFor)];
  const payload = serialize(row, "open");
  for (const room of rooms.length ? rooms : [ALERTS_ROOM]) {
    await session.outbox.enqueue({ room, type: "alert.created", aggregateId: row.id, payload });
  }
  return row;
}

// ---------- factory das use cases de leitura/escrita do sino ----------

export interface AlertUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

/**
 * `GET /alerts` e `POST /alerts/mark-read` sobre o Unit-of-Worker.
 *
 * O recorte de visibilidade (`visibleTo`) é SQL e mora no ADAPTER
 * (`PostgresAlertRepository`) — o port recebe `role`/`userId` e aplica a mesma
 * régua de sempre, então REST e mark-read continuam concordando.
 */
export function createAlertUsecases(deps: AlertUsecasesDeps) {
  return {
    // ---------- GET /alerts ----------
    async listAlertsUsecase(input: {
      role: string;
      /** `sub` de quem pergunta — habilita a audiência individual (`user:<id>`). */
      userId?: string | null;
      limit: number;
      unreadOnly?: boolean;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.alerts.listVisible({
          role: input.role,
          userId: input.userId,
          limit: input.limit,
          unreadOnly: input.unreadOnly,
        });

        // Status das comandas em UMA consulta: a listagem mostra a comanda como
        // "encerrada" (e o clique deixa de navegar) sem N+1 — a lição do roadmap 3.3.
        const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => Boolean(id)))];
        const statusRows = orderIds.length ? await session.orders.listStatuses(orderIds) : [];
        const statusByOrder = new Map(statusRows.map((r) => [r.id, r.status as string]));

        // Contadores SEM o `unread_only` (senão o badge marcaria zero depois de
        // o cliente filtrar a lista) — do conjunto TODO que quem pergunta enxerga.
        const counts = await session.alerts.countVisible({ role: input.role, userId: input.userId });

        return {
          data: rows.map((r) => serialize(r, statusByOrder.get(r.orderId ?? ""))),
          // `total` e `unread` são do conjunto TODO que quem pergunta enxerga, não da
          // janela de `limit`: com 30 comandas esperando, o badge precisa dizer 30.
          total: counts.total,
          unread: counts.unread,
        };
      });
    },

    // ---------- POST /alerts/mark-read ----------
    /**
     * Marca como lido. Com `orderId`, é a regra do app: "quando a tela do pedido
     * for visualizada, desmarcar o alerta" (o `OrderDetailScreen` chama ao abrir).
     * Sem `orderId`, é o botão "marcar todas como lidas" do sino.
     *
     * Só o que o chamador enxerga é alterado (mesmo recorte da listagem), e
     * linhas já lidas não são reescritas — o `marked` é o que realmente mudou.
     */
    async markAlertsReadUsecase(input: {
      role: string;
      userId?: string | null;
      orderId?: string;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const marked = await session.alerts.markRead({
          role: input.role,
          userId: input.userId,
          orderId: input.orderId,
        });
        return { marked };
      });
    },
  };
}

export type AlertUsecases = ReturnType<typeof createAlertUsecases>;
