import React, { useState } from "react";
import { openOrder } from "@/entities/order";
import { useAuth } from "@/app/providers/auth";
import { useOrders } from "./useOrders.js";
import { useToast, Toast } from "@/shared/components";
import OrderListScreen from "./OrderListScreen.jsx";
import OrderDetailScreen from "./OrderDetailScreen.jsx";
import { NewOrderModal } from "@/features/orders";

export default function OrderBoard() {
  const { storeSettings } = useAuth();
  const { orders, loading, reloadAll, reloadOne, setOrders } = useOrders();
  const { toast, showToast } = useToast();
  const [openOrderId, setOpenOrderId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const usesTables = storeSettings?.usesTables ?? true;

  const openOrderRecord = orders.find((o) => o.id === openOrderId) ?? null;

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