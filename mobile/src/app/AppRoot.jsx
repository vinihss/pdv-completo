// Novo: composição da raiz do app (análogo ao main.tsx do web). Ordem
// importa: AppConfigProvider seta a config global antes do AuthProvider bootar
// (a restauração de sessão e o getStoreSettings dependem da origem), e ambos
// precisam estar prontos quando o RootNavigator montar.
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppConfigProvider } from "@/app/providers/appConfig";
import { AuthProvider } from "@/app/providers/auth";
import { RootNavigator } from "@/app/navigation/RootNavigator";

export default function AppRoot() {
  return (
    <SafeAreaProvider>
      <AppConfigProvider>
        <AuthProvider>
          <StatusBar style="light" hidden />
          <NavigationContainer>
            <RootNavigator />
          </NavigationContainer>
        </AuthProvider>
      </AppConfigProvider>
    </SafeAreaProvider>
  );
}