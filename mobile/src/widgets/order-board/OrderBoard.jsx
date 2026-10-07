// Tela "Comandas" do fluxo do garçom — porta do OrderBoard web
// (frontend/src/widgets/order-board/OrderBoard.jsx) na navegação nativa:
// a comanda não troca de estado local, navega para Detail; o foco vindo do
// sino navega também (esse é o papel do OrderFlowContext).
import { useEffect, useState } from "react";
import { useAuth } from "@/app/providers/auth";
import OrderListScreen from "./OrderListScreen.jsx";
import { useOrderFlow } from "./OrderFlowProvider.jsx";

export default function OrderBoard({ navigation }) {
  const { storeSettings } = useAuth();
  const { orders, loading, error, reloadAll, focusedOrderId, clearFocus } = useOrderFlow();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const usesTables = storeSettings?.usesTables ?? true;

  // Foco vindo do sino: o id só é esgotado depois de a comanda existir na
  // lista (senão abriria tela vazia enquanto o useOrders ainda busca).
  useEffect(() => {
    if (!focusedOrderId) return;
    if (orders.some((o) => o.id === focusedOrderId)) {
      clearFocus();
      navigation.navigate("Detail", { orderId: focusedOrderId });
    }
  }, [focusedOrderId, orders, clearFocus, navigation]);

  return (
    <OrderListScreen
      orders={orders}
      loading={loading}
      error={error}
      kitchenEnabled={kitchenEnabled}
      usesTables={usesTables}
      filter={filter}
      search={search}
      onFilter={setFilter}
      onSearch={setSearch}
      onOpenOrder={(orderId) => navigation.navigate("Detail", { orderId })}
      onNewOrder={() => navigation.navigate("NewOrder")}
      onReloadAll={reloadAll}
    />
  );
}