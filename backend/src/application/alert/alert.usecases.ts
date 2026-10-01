// Central de alertas (migration 0004): o que chega no salão (hoje, a abertura
// de uma comanda) e o estado de "não visualizado".
//
// Por que uma tabela, e não só o `outbox_event`: o outbox é descarte — a linha
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
//             audiência — é o fan-out que impede o alerta de vazar para quem não
//             deveria ouvir (ex.: o garçom, que abriu a comanda e já está olhando
//             para ela).
//
// `read_at` é global, não por usuário: a pergunta é "alguém do salão já viu
// isso?" e quem responde é a tela da comanda. Não gera linha de audit_log —
// o evento de domínio (`order_opened`) já está auditado em openOrderUsecase;
// o alerta é só a projeção dele na beirada.

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import { alerts, orders } from "../../infra/db/schema.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

/** Room público: alerta sem restrição de público. */
export const ALERTS_ROOM = "alerts";
/** Room por papel — o cliente assina `alerts` + `alerts:<seu papel>`. */
export function alertsRoomFor(role: string) {
  return `${ALERTS_ROOM}:${role}`;
}

/**
 * Audiência INDIVIDUAL: alerta que é de uma pessoa só (o entregador X recebeu a
 * entrega Y), e não de um papel. O token viaja no mesmo `audience_roles` (que é
 * TEXT[]) com o prefixo `user:`, então é a MESMA coluna e o MESMO predicado
 * que já filtram por papel — nenhum schema novo, nenhuma migration.
 *
 * A alternativa era um room `alerts:courier` + filtro no cliente, que foi
 * descartada: o room por papel é compartilhado por todos os entregadores, então
 * todo mundo ouviria o mesmo `alert.created` e a fila de "quem é meu" passaria
 * a depender de o cliente filtrar — com o sino já tocando antes disso. E
 * adicionar `courier` à audiência global (`ORDER_ALERT_AUDIENCE`) era
 * exatamente o que não pode: tocaria o sino de TODOS os entregadores a cada
 * pedido que caísse, mesmo os que não são dele.
 *
 * O room pessoal entra no handshake (ver realtime.routes.ts), então o cliente
 * atual — que só assina `alerts` + `alerts:<papel>` e reage a qualquer
 * `alert.created` — passa a receber o alerta direcionado sem mudar uma linha.
 */
export function alertUserToken(userId: string) {
  return `user:${userId}`;
}

/** Room privado de um usuário — o par de `alertUserToken` no realtime. */
export function alertsUserRoomFor(userId: string) {
  return `${ALERTS_ROOM}:${alertUserToken(userId)}`;
}

export const ORDER_ALERT_KIND = "order_created";

/**
 * Kind do alerta direcionado da atribuição: "essa entrega agora é SUA".
 * Distinto de `order_created` de propósito — é o que permite o sino (e o
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
  whatsapp: "WhatsApp",
  ifood: "iFood",
};

/**
 * Texto do alerta de comanda. Função pura de propósito: quem chama (a
 * self-service, o iFood e o balcão passam pelo mesmo `openOrderUsecase`) monta
 * o `label` e o `customerName`, e aqui a frase é decidida uma vez só — é o que
 * a suíte testa sem precisar de banco.
 *
 *   balcão  -> "Nova comanda · Mesa 3"   / corpo "Balcão"
 *   web     -> "Novo pedido de Ana"      / corpo "Entrega · página"
 *   ifood   -> "Novo pedido do iFood"    / corpo "iFood 1234"
 */
export function describeOrderAlert(input: {
  channel: "balcao" | "whatsapp" | "web" | "ifood";
  /** "Mesa 3" (mesa) ou o tabLabel da comanda ("Delivery - Ana", "iFood 99"). */
  label?: string | null;
  customerName?: string | null;
}): { title: string; body: string } {
  const label = input.label?.trim() || null;
  const channel = CHANNEL_LABEL[input.channel] ?? input.channel;

  if (input.channel === "ifood") {
    return { title: `Novo pedido do ${channel}`, body: label ?? "" };
  }
  if (input.channel === "web" || input.channel === "whatsapp") {
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
 * para sair, e porque ele já está no `delivery` — o nome exigiria o join da
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

type AlertRow = typeof alerts.$inferSelect;

function serialize(row: AlertRow, orderStatus?: string | null) {
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
 * transação deixaria o evento e a linha nasceriam por caminhos diferentes — o
 * sino tocaria para uma comanda que não chegou a existir.
 *
 * `audience` (papéis) e `userIds` (pessoas) se somam no mesmo `audience_roles`:
 * quem está em qualquer um dos dois recebe. Os dois vazios = alerta público.
 */
export async function createAlertTx(
  tx: Tx,
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
  }
) {
  const audience = input.audience ?? [];
  const userIds = input.userIds ?? [];
  const [row] = await tx
    .insert(alerts)
    .values({
      kind: input.kind ?? ORDER_ALERT_KIND,
      title: input.title,
      body: input.body ?? null,
      orderId: input.orderId ?? null,
      channel: input.channel ?? null,
      audienceRoles: [...audience, ...userIds.map(alertUserToken)],
    })
    .returning();

  // Um insert por room: um para cada papel e um para cada pessoa da audiência.
  // Sem papel e sem pessoa, o room único `alerts` (que todo mundo logado
  // assina) evita cinco linhas de outbox para um alerta que é de todo mundo.
  const rooms = [...audience.map(alertsRoomFor), ...userIds.map(alertsUserRoomFor)];
  const payload = serialize(row, "open");
  for (const room of rooms.length ? rooms : [ALERTS_ROOM]) {
    await enqueueEvent(tx, room, "alert.created", payload);
  }
  return row;
}

/**
 * Alertas visíveis para quem pergunta: audiência vazia (NULL) é para todos, senão
 * o papel (ou o próprio usuário) precisa estar na lista. Mesmo predicado no REST
 * e no `mark-read` — se divergissem, o "marcar todas como lidas" do garçom
 * limparia o contador do gerente, que ele nem enxerga.
 *
 * `userId` é o que faz o alerta direcionado aparecer para o dono dele. Sem
 * `userId` (um chamador que não conhece o usuário), a audiência pessoal fica
 * invisível no REST — fail-closed: melhor o sino do destinatário não ser
 * contarizado do que outro courier ler o endereço de uma entrega que não é dele.
 */
function visibleTo(role: string, userId?: string | null) {
  const tokens = userId ? [role, alertUserToken(userId)] : [role];
  return or(
    isNull(alerts.audienceRoles),
    sql`cardinality(${alerts.audienceRoles}) = 0`,
    ...tokens.map((token) => sql`${token} = ANY(${alerts.audienceRoles})`)
  );
}

// ---------- GET /alerts ----------
export async function listAlertsUsecase(input: {
  role: string;
  /** `sub` de quem pergunta — habilita a audiência individual (`user:<id>`). */
  userId?: string | null;
  limit: number;
  unreadOnly?: boolean;
}) {
  const conditions = [visibleTo(input.role, input.userId)];
  if (input.unreadOnly) conditions.push(isNull(alerts.readAt));

  const rows = await db.query.alerts.findMany({
    where: and(...conditions),
    orderBy: [desc(alerts.createdAt), desc(alerts.seq)],
    limit: input.limit,
  });

  // Status das comandas em UMA consulta: a listagem mostra a comanda como
  // "encerrada" (e o clique deixa de navegar) sem N+1 — a lição do roadmap 3.3.
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => Boolean(id)))];
  const statusRows = orderIds.length
    ? await db.select({ id: orders.id, status: orders.status }).from(orders).where(inArray(orders.id, orderIds))
    : [];
  const statusByOrder = new Map(statusRows.map((r) => [r.id, r.status as string]));

  // Contadores numa query só, e SEM o `unread_only` (senão o badge marcaria
  // zero depois de o cliente filtrar a lista). `::int` porque `count(*)` no
  // Postgres é bigint e sai como string — mesma pegadinha do roadmap 3.3.
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${alerts.readAt} is null)::int`,
    })
    .from(alerts)
    .where(visibleTo(input.role, input.userId) as any);

  return {
    data: rows.map((r) => serialize(r, statusByOrder.get(r.orderId ?? ""))),
    // `total` e `unread` são do conjunto TODO que quem pergunta enxerga, não da
    // janela de `limit`: com 30 comandas esperando, o badge precisa dizer 30.
    total: counts?.total ?? 0,
    unread: counts?.unread ?? 0,
  };
}

// ---------- POST /alerts/mark-read ----------
/**
 * Marca como lido. Com `orderId`, é a regra do app: "quando a tela do pedido
 * for visualizada, desmarcar o alerta" (o `OrderDetailScreen` chama ao abrir).
 * Sem `orderId`, é o botão "marcar todas como lidas" do sino.
 *
 * Só o que o chamador enxerga é alterado (mesmo `visibleTo` da listagem), e
 * linhas já lidas não são reescritas — o `marked` é o que realmente mudou.
 */
export async function markAlertsReadUsecase(input: {
  role: string;
  userId?: string | null;
  orderId?: string;
}) {
  const conditions = [visibleTo(input.role, input.userId), isNull(alerts.readAt)];
  if (input.orderId) conditions.push(eq(alerts.orderId, input.orderId));

  const marked = await db
    .update(alerts)
    .set({ readAt: new Date().toISOString() })
    .where(and(...conditions) as any)
    .returning({ id: alerts.id });

  return { marked: marked.length };
}
