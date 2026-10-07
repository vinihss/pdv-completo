// Raiz da navegação (não existe análogo no web — lá o chaveamento é o React
// Router). Quatro ramos, um por estado do app:
//   1. sem servidor configurado       → só Setup (o app não vai a lugar nenhum);
//   2. servidor, sem credencial       → Provision (primeiro acesso — docs/21 §5.2);
//   3. credencial de aparelho, sem JWT → Lock/PIN (docs/21 §5.3);
//   4. com JWT                        → Main (o fluxo da variante do build).
//
// O ramo 2 carrega Login/Setup também: o "Entrar sem provisionar" (só `__DEV__`)
// navega para o login antigo por grade, e "Trocar servidor" abre o Setup.
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "@/app/providers/auth";
import { useAppConfig } from "@/app/providers/appConfig";
import LoginPage from "@/pages/login/LoginPage";
import SetupPage from "@/pages/login/SetupPage";
import ProvisionPage from "@/pages/provision/ProvisionPage";
import GarconFlowStub from "@/pages/garcon/GarconFlowStub";
import CourierFlowStub from "@/pages/courier/CourierFlowStub";
import { APP_VARIANT } from "@/shared/lib/variant";

const Stack = createNativeStackNavigator();

function BootingSplash() {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashText}>PDV</Text>
    </View>
  );
}

function MainScreen() {
  // A variante é decidida no BUILD (APP_VARIANT), não em runtime: cada a loja
  // instala um apk. Quem entra no estoque/entrega do outro perfil não existe
  // — o stub do fluxo é só o esqueleto para as Frentes 2/3 preencherem.
  return APP_VARIANT === "entregador" ? <CourierFlowStub /> : <GarconFlowStub />;
}

export function RootNavigator() {
  const { session, booting, deviceCredential } = useAuth();
  const { configured } = useAppConfig();

  if (booting) {
    return <BootingSplash />;
  }

  if (!configured && !session) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false, fullScreenGestureEnabled: true }}>
        <Stack.Screen name="Setup" component={SetupPage} />
      </Stack.Navigator>
    );
  }

  // Primeiro acesso: sem credencial de aparelho o app pede a chave (Provision).
  // Login entra na pilha só para o escape de desenvolvimento.
  if (!session && !deviceCredential) {
    return (
      <Stack.Navigator
        screenOptions={{ headerShown: false, fullScreenGestureEnabled: true }}
        initialRouteName="Provision"
      >
        <Stack.Screen name="Provision" component={ProvisionPage} />
        <Stack.Screen name="Setup" component={SetupPage} />
        <Stack.Screen name="Login" component={LoginPage} />
      </Stack.Navigator>
    );
  }

  // Aparelho provisionado, sessão bloqueada/ausente: só desbloqueio (PIN ou
  // biometria). A grade de usuários não existe mais neste aparelho (§5.3).
  if (!session) {
    return (
      <Stack.Navigator
        screenOptions={{ headerShown: false, fullScreenGestureEnabled: true }}
        initialRouteName="Login"
      >
        <Stack.Screen name="Setup" component={SetupPage} />
        <Stack.Screen name="Login" component={LoginPage} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Main" component={MainScreen} />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: "#0c0a09", // stone-950
    alignItems: "center",
    justifyContent: "center",
  },
  splashText: {
    color: "#fbbf24", // amber-400
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 8,
  },
});
