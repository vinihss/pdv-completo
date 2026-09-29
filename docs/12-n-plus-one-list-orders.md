# Plano: Eliminar N+1 em `listOrdersUsecase`

## Problema

`listOrdersUsecase` (`backend/src/application/order/order.usecases.ts:944-955`) faz:

```
1 query  → busca N comandas (limit=50)
50 × 5 queries → serializeOrder para cada (250 queries)
1 query  → count total
```

**Total: ~252 queries por request.**

### Por que é lento

Cada `serializeOrder` executa 5 queries independentes:
1. `orders.findFirst` — dados da comanda
2. `orderItems.innerJoin(products)` — itens com nome/foto do produto
3. `restaurantTables.findFirst` — mesa (se houver)
4. `customers.findFirst` — cliente (se houver)
5. `orderPayments.findMany` — pagamentos

Com o `limit` padrão de 50, são 250 queries só de serialização.

## Solução: Batch queries + montagem em memória

Substituir `Promise.all(rows.map(o => serializeOrder(o.id)))` por 4 queries em lote + montagem via mapas.

### Alvo

```typescript
export async function listOrdersUsecase(input: { status?: "open" | "closed"; limit: number; offset: number }) {
  const where = input.status ? eq(orders.status, input.status) : undefined;

  // 1. Comandas paginadas
  const rows = await db.query.orders.findMany({
    where,
    orderBy: desc(orders.openedAt),
    limit: input.limit,
    offset: input.offset,
  });

  if (rows.length === 0) {
    const totalRow = await db.select({ count: count() }).from(orders).where(where as any);
    return { data: [], total: totalRow[0]?.count ?? 0 };
  }

  const orderIds = rows.map(o => o.id);

  // 2. Todos os items de UMA VEZ
  const itemsWithProducts = await db
    .select({
      item: orderItems,
      productName: products.name,
      productImagePath: products.imagePath,
      productKitchenGroupId: products.kitchenGroupId,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds));

  // 3. Todos os pagamentos de UMA VEZ
  const allPayments = await db.query.orderPayments.findMany({
    where: inArray(orderPayments.orderId, orderIds),
  });

  // 4. Mesas e clientes em lote
  const tableIds = [...new Set(rows.map(o => o.tableId).filter(Boolean))] as string[];
  const customerIds = [...new Set(rows.map(o => o.customerId).filter(Boolean))] as string[];

  const [tables, customers] = await Promise.all([
    tableIds.length > 0
      ? db.query.restaurantTables.findMany({ where: inArray(restaurantTables.id, tableIds) })
      : Promise.resolve([]),
    customerIds.length > 0
      ? db.query.customers.findMany({ where: inArray(customers.id, customerIds) })
      : Promise.resolve([]),
  ]);

  // 5. Mapas de lookup O(1)
  const tableMap = new Map(tables.map(t => [t.id, t]));
  const customerMap = new Map(customers.map(c => [c.id, c]));

  const itemsByOrder = new Map<string, typeof itemsWithProducts>();
  for (const row of itemsWithProducts) {
    const list = itemsByOrder.get(row.item.orderId) ?? [];
    list.push(row);
    itemsByOrder.set(row.item.orderId, list);
  }

  const paymentsByOrder = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const list = paymentsByOrder.get(p.orderId) ?? [];
    list.push(p);
    paymentsByOrder.set(p.orderId, list);
  }

  // 6. Serializa sem queries
  const data = rows.map(order => ({
    id: order.id,
    status: order.status,
    tableId: order.tableId,
    tableNumber: order.tableId ? tableMap.get(order.tableId)?.number ?? null : null,
    customerId: order.customerId,
    customerName: order.customerId ? customerMap.get(order.customerId)?.name ?? null : null,
    tabLabel: order.tabLabel,
    waiterId: order.waiterId,
    channel: order.channel,
    externalRef: order.externalRef,
    deliveryFee: order.deliveryFee,
    cancelReason: order.cancelReason,
    paymentMethod: order.paymentMethod,
    paymentConfirmedAt: order.paymentConfirmedAt,
    paymentConfirmedBy: order.paymentConfirmedBy,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    items: (itemsByOrder.get(order.id) ?? []).map(({ item, productName, productImagePath, productKitchenGroupId }) =>
      serializeItem(item, {
        name: productName,
        imagePath: productImagePath,
        kitchenGroupId: productKitchenGroupId,
      })
    ),
    payments: (paymentsByOrder.get(order.id) ?? []).map(serializePayment),
  }));

  // 7. Count total
  const totalRow = await db.select({ count: count() }).from(orders).where(where as any);

  return { data, total: totalRow[0]?.count ?? data.length };
}
```

## Impacto

| Métrica | Antes | Depois |
|---------|-------|--------|
| Queries por request | ~252 | **5** |
| Complexidade no banco | O(N) | O(1) |
| Complexidade em memória | O(1) | O(N) (mapas de lookup) |
| Contrato de API | — | **Inalterado** |

## Arquivos

| Arquivo | Ação |
|---------|------|
| `docs/12-n-plus-one-list-orders.md` | **Criar** — este documento |
| `backend/src/application/order/order.usecases.ts` | **Modificar** — `listOrdersUsecase` (linhas 944-955) |
| `backend/test/order-flow.test.ts` | **Adicionar** — teste de contagem de queries |

## Testes

1. **Corretude**: `listOrdersUsecase` retorna mesmos dados que `getOrderUsecase` para N comandas
2. **Performance**: com 50 comandas, verificar que o número de queries é ≤ 5
3. **Bordas**: lista vazia, comanda sem mesa, sem cliente, sem pagamentos

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Memória com 50 comandas × 20 items = 1000 items | Aceitável — itens são leves (~200 bytes cada) |
| `inArray` com lista vazia | Early return quando `rows.length === 0` |
| Mudança de contrato de API | Nenhuma — formato de retorno idêntico |
