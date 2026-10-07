// Fluxo interno do garçom (Frente 2) — Stack nativa com Board/Detail/AddItem/NewOrder/Payment.
// Wrapped em AlertsBoxProvider + OrderFlowProvider + ToastProvider (porta do fluxo web).
// Board recebe sino (AlertBell) no header; o AlertsBoxProvider fica POR FORA do
// stack porque o sino (casca) e o detalhe da comanda (página) precisam da mesma
// caixa de alertas — é o que permite a tela descontar o alerta ao abrir.
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { AlertsBoxProvider } from "@/widgets/order-board/AlertsBoxProvider.jsx";
import { OrderFlowProvider } from "@/widgets/order-board/OrderFlowProvider.jsx";
import { ToastProvider } from "@/widgets/order-board/Toast.jsx";
import OrderBoard from "@/widgets/order-board/OrderBoard.jsx";
import OrderDetailScreen from "@/widgets/order-board/OrderDetailScreen.jsx";
import AddItemScreen from "@/features/orders/AddItemScreen.jsx";
import NewOrderScreen from "./NewOrderScreen.jsx";
import PaymentScreen from "@/features/orders/PaymentScreen.jsx";
import { AlertBell } from "@/widgets/order-board/AlertBell.jsx";

const Stack = createNativeStackNavigator();

function GarconStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="Board"
        component={OrderBoard}
        options={{
          title: "Comandas",
          headerRight: () => <AlertBell />,
        }}
      />
      <Stack.Screen name="Detail" component={OrderDetailScreen} options={{ title: "Comanda" }} />
      <Stack.Screen name="AddItem" component={AddItemScreen} options={{ title: "Adicionar itens" }} />
      <Stack.Screen
        name="NewOrder"
        component={NewOrderScreen}
        options={{
          title: "Nova comanda",
          presentation: "modal",
        }}
      />
      <Stack.Screen
        name="Payment"
        component={PaymentScreen}
        options={{
          title: "Pagamento",
          presentation: "modal",
        }}
      />
    </Stack.Navigator>
  );
}

export default function GarconFlowStub() {
  return (
    <AlertsBoxProvider>
      <OrderFlowProvider>
        <ToastProvider>
          <GarconStack />
        </ToastProvider>
      </OrderFlowProvider>
    </AlertsBoxProvider>
  );
}