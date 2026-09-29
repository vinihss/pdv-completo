import React, { useEffect, useState } from "react";
import { openOrder } from "@/entities/order";
import { useAuth } from "@/app/providers/auth";
import { useAlerts } from "@/app/providers/alerts";
import { useOrderFocus } from "@/app/providers/order-focus";
import { useOrders } from "./useOrders.js";
import { useToast, Toast } from "@/shared/components";
import OrderListScreen from "./OrderListScreen.jsx";
import OrderDetailScreen from "./OrderDetailScreen.jsx";
import { NewOrderModal } from "@/features/orders";

export default function OrderBoard() {
  const { storeSettings } = useAuth();
  const { orders, loading, reloadAll, reloadOne, setOrders } = useOrders();
  const { toast, showToast } = useToast();
  const { markRead } = useAlerts();
  const { focusedOrderId, clearFocus } = useOrderFocus();
  const [openOrderId, setOpenOrderId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const usesTables = storeSettings?.usesTables ?? true;

  const openOrderRecord = orders.find((o) => o.id === openOrderId) ?? null;

  // Foco vindo do sino: o id só é esgote depois de a comanda existir na lista,
  // senão o `OrderBoard` abriria uma tela vazia (o `useOrders` ainda está
  // buscando). Depois disso o alerta já foi marcado como lido no clique.
  useEffect(() => {
    if (!focusedOrderId) return;
    if (openOrderId === focusedOrderId) {
      clearFocus();
      return;
    }
    if (orders.some((o) => o.id === focusedOrderId)) {
      setOpenOrderId(focusedOrderId);
      clearFocus();
    }
  }, [focusedOrderId, orders, openOrderId, clearFocus]);

  // "A tela da comanda foi visualizada → desmarcar o alerta". Vale para abrir por
  // qualquer caminho (menu, lista, sino). Comanda sem alerta nenhum (aberta
  // direto na lista, ou de um dia que já saiu da janela de 7 dias) o POST volta
  // `marked: 0` e não há o que fazer.
  const openOrderIdShown = openOrderRecord?.id;
  useEffect(() => {
    if (openOrderIdShown) markRead(openOrderIdShown);
  }, [openOrderIdShown, markRead]);

  async function handleOpenNewOrder(identification) {
    try {
      const order = await openOrder(identification);
      setOrders((prev) => [order, ...prev]);
      setNewOrderOpen(false);
      setOpenOrderId(order.id);
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  if (openOrderRecord) {
    return (
      <>
        <OrderDetailScreen
          order={openOrderRecord}
          kitchenEnabled={kitchenEnabled}
          onBack={() => setOpenOrderId(null)}
          onReload={() => reloadOne(openOrderRecord.id)}
          showToast={showToast}
        />
        <Toast toast={toast} />
      </>
    );
  }

  return (
    <>
      <OrderListScreen
        orders={orders}
        loading={loading}
        kitchenEnabled={kitchenEnabled}
        usesTables={usesTables}
        filter={filter}
        setFilter={setFilter}
        search={search}
        setSearch={setSearch}
        onOpenOrder={setOpenOrderId}
        onNewOrder={() => setNewOrderOpen(true)}
        onReloadAll={reloadAll}
      />
      {newOrderOpen && (
        <NewOrderModal usesTables={usesTables} onClose={() => setNewOrderOpen(false)} onConfirm={handleOpenNewOrder} />
      )}
      <Toast toast={toast} />
    </>
  );
}