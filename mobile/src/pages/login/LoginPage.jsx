// Portado de frontend/src/pages/login/LoginPage.jsx (adaptação RN). Mesma
// UX/regras (PIN 4–6, envio EXPLÍCITO, erro de tentativa em 4s, erro
// too_many_attempts), sem o modal de servidor: no aparelho a troca de
// servidor é UMA TELA (SetupPage), aberta pelo "[[power]]Servidor:" da grade
// de usuários — o web abria um modal e recarregava a página, o RN não tem
// reload.
//
// Diferenças RN de comportamento:
//   - teclado físico → só o TextInput transparente sobre os pontos (não há
//     window.keydown); tocar na linha abre o teclado do aparelho.
//   - refetch ao SOBRAR o foco (useFocusEffect, não useEffect): voltar do
//     Setup re-busca usuários/logo/tag do servidor que acabou de mudar.
//   - sem applyBrandPrimary: a paleta é única (theme.js).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { listLoginUsers } from "@/entities/session";
import { getStoreInfo } from "@/entities/store";
import { isCredentialInvalidError, loginErrorMessage } from "@/entities/provisioning";
import { useAuth } from "@/app/providers/auth";
import { useAppConfig } from "@/app/providers/appConfig";
import UserAvatar from "@/shared/components/UserAvatar";
import { COLORS } from "@/shared/lib/theme";
import { currentServerLabel, fetchTag } from "@/shared/lib/server";

const MAX_PIN = 6;
const MIN_PIN = 4;

// Mesmos ícones que o web (lucide) na equivalência Ionicons. manager/courier/
// system usavam UtensilsCrossed: aqui manager vira "restaurant" (dona da
// casa), courier vira "bicycle" (entrega) e system vira "pulse" (estação).
const ROLE_META = {
  waiter: { label: "Garçom", icon: "clipboard-outline" },
  kitchen: { label: "Cozinha", icon: "fast-food-outline" },
  manager: { label: "Gerente", icon: "restaurant-outline" },
  courier: { label: "Entregador", icon: "bicycle-outline" },
  cashier: { label: "Caixa", icon: "wallet-outline" },
  system: { label: "System", icon: "pulse-outline" },
};

// Só dígitos, no máximo MAX_PIN: mesma regra para o keypad e para o input
// transparente (teclado nativo do aparelho).
function onlyDigits(value) {
  return (value ?? "").replace(/\D/g, "").slice(0, MAX_PIN);
}

export default function LoginPage({ navigation }) {
  const {
    login,
    deviceCredential,
    biometricEnabled,
    biometricAvailable,
    unlockWithBiometrics,
    setBiometricEnabled,
  } = useAuth();
  const { configured } = useAppConfig();
  const [screen, setScreen] = useState("select"); // select | pin
  const [users, setUsers] = useState([]);
  const [storeName, setStoreName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [biometricToggle, setBiometricToggle] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [serverTag, setServerTag] = useState(null);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const pinInputRef = useRef(null);

  // Aparelho provisionado (docs/21 §5.3): a grade NÃO aparece; a tela vira o
  // desbloqueio do usuário vinculado. Sem credencial, o fluxo antigo continua.
  const provisioned = Boolean(deviceCredential);
  const activeUser = provisioned ? deviceCredential.user : selectedUser;

  // Re-busca a cada vez que a tela ganha foco: ao voltar do Setup o servidor
  // pode ter mudado, e usuários/logo/tag vêm do servidor novo. No modo
  // provisionado a grade não existe, então só servidor/loja são recarregados.
  useFocusEffect(
    useCallback(() => {
      if (!provisioned) {
        listLoginUsers()
          .then(setUsers)
          .catch((e) => setLoadError(e.message))
          .finally(() => setLoadingUsers(false));
      }
      getStoreInfo()
        .then((s) => {
          setStoreName(s?.merchantName || "");
          setLogoUrl(s?.logoUrl || "");
        })
        .catch(() => {});
      fetchTag()
        .then(setServerTag)
        .catch(() => setServerTag(null));
    }, [provisioned]),
  );

  // Sem setup inicial, a grade fica vazia com o erro claro — o app que chega
  // aqui sempre tem servidor, mas o plano B é legível.
  useEffect(() => {
    if (!configured) setLoadError(null);
  }, [configured]);

  function openPinScreen(user) {
    setSelectedUser(user);
    setPin("");
    setError(null);
    setScreen("pin");
  }

  function backToSelect() {
    setScreen("select");
    setSelectedUser(null);
    setPin("");
    setError(null);
  }

  const pressDigit = useCallback(
    (d) => {
      if (checking) return;
      setPin((p) => (p.length >= MAX_PIN ? p : p + d));
      setError(null);
    },
    [checking],
  );

  const backspace = useCallback(() => {
    if (checking) return;
    setPin((p) => p.slice(0, -1));
    setError(null);
  }, [checking]);

  const shake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 28, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -28, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 14, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -14, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const attemptLogin = useCallback(
    async (candidatePin, userId) => {
      setChecking(true);
      try {
        await login(userId, candidatePin);
        // Sucesso: o RootNavigator troca a árvore para Main. Antes de sumir,
        // honra a preferência de biometria marcada na tela (docs/21 §3).
        if (provisioned && biometricAvailable && biometricToggle) {
          setBiometricEnabled(true);
        }
      } catch (e) {
        setChecking(false);
        // Aparelho revogado/desconhecido: o AuthProvider já apagou a credencial
        // e o RootNavigator volta para Provision (docs/21 §12, critérios 5/6).
        if (isCredentialInvalidError(e)) {
          setError("Este aparelho não está mais autorizado. Provisione novamente.");
          return;
        }
        setError(loginErrorMessage(e));
        setPin("");
        shake();
      }
    },
    [login, provisioned, biometricAvailable, biometricToggle, setBiometricEnabled, shake],
  );

  // Desbloqueio por biometria: mesma porta do boot, acionada pelo botão da
  // tela quando o prompt automático foi dispensado.
  const onBiometricUnlock = useCallback(async () => {
    if (biometricBusy) return;
    setError(null);
    setBiometricBusy(true);
    try {
      await unlockWithBiometrics();
    } catch (e) {
      setBiometricBusy(false);
      if (isCredentialInvalidError(e)) {
        setError("Este aparelho não está mais autorizado. Provisione novamente.");
        return;
      }
      if (e?.code !== "biometric_cancelled") {
        setError("Não foi possível desbloquear. Use o PIN.");
      }
    }
  }, [biometricBusy, unlockWithBiometrics]);

  // Só entra com 4+ dígitos: o PIN do cadastro vai de 4 a 6, e completar a
  // sequência não pode ser o gatilho — o envio é explícito (Enter ou "Entrar").
  const confirmPin = useCallback(() => {
    if (checking || !activeUser) return;
    if (pin.length >= MIN_PIN) attemptLogin(pin, activeUser.id);
  }, [checking, pin, activeUser, attemptLogin]);

  if (!provisioned && screen === "select") {
    return (
      <ScrollView style={styles.select} contentContainerStyle={styles.selectContent}>
        <View style={styles.selectHeader}>
          {logoUrl ? (
            <View style={styles.logoWrap}>
              <View style={styles.logoMock}>
                <Ionicons name="restaurant-outline" size={28} color={COLORS.accentForeground} />
              </View>
            </View>
          ) : (
            <View style={styles.logoMock}>
              <Ionicons name="lock-closed" size={26} color={COLORS.accentForeground} />
            </View>
          )}
          <Text style={styles.storeName}>{storeName || "PDV"}</Text>
          <Text style={styles.selectSubtitle}>Selecione seu nome para continuar</Text>
        </View>

        {loadingUsers && <ActivityIndicator color={COLORS.accent} size="large" style={styles.spinner} />}

        {loadError && (
          <Text style={styles.loadError}>
            Não foi possível conectar ao servidor. Verifique o backend da loja.
          </Text>
        )}

        {!loadingUsers && !loadError && (
          <View style={styles.grid}>
            {users.map((u) => {
              const meta = ROLE_META[u.role] ?? { label: u.role, icon: "person-outline" };
              return (
                <Pressable
                  key={u.id}
                  onPress={() => openPinScreen(u)}
                  style={({ pressed }) => [styles.userCard, pressed && styles.userCardPressed]}
                >
                  <UserAvatar name={u.name} photoPath={u.photoPath} size={56} />
                  <Text style={styles.userName} numberOfLines={1}>
                    {u.name}
                  </Text>
                  <View style={styles.userRole}>
                    <Ionicons name={meta.icon} size={11} color={COLORS.faint} />
                    <Text style={styles.userRoleLabel}>{meta.label}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        <Pressable
          onPress={() => navigation.navigate("Setup")}
          style={({ pressed }) => [styles.serverRow, pressed && styles.serverRowPressed]}
        >
          <Ionicons name="server-outline" size={12} color={COLORS.faint} />
          <Text style={styles.serverLabel} numberOfLines={1}>
            Servidor: {currentServerLabel()}
            {serverTag ? ` v${serverTag}` : ""}
          </Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.pinScreen}
    >
      {activeUser && (
        <>
          <View style={styles.pinHeader}>
            <UserAvatar name={activeUser.name} photoPath={activeUser.photoPath} size={64} />
            <Text style={styles.pinName}>{activeUser.name}</Text>
            <Text style={styles.pinSubtitle}>
              {provisioned ? "Desbloqueie o aparelho com seu PIN" : "Digite seu PIN"}
            </Text>
          </View>

          <Animated.View style={[styles.dotsRow, { transform: [{ translateX: shakeAnim }] }]}>
            <View style={styles.dots}>
              {Array.from({ length: Math.max(pin.length, MIN_PIN) }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    i < pin.length ? (error ? styles.dotError : styles.dotFilled) : styles.dotEmpty,
                  ]}
                />
              ))}
            </View>
            <TextInput
              ref={pinInputRef}
              value={pin}
              onChangeText={(v) => {
                setPin(onlyDigits(v));
                setError(null);
              }}
              keyboardType="number-pad"
              secureTextEntry
              caretHidden
              maxLength={MAX_PIN}
              style={styles.pinInput}
            />
          </Animated.View>

          <View style={styles.pinFeedback}>
            {error ? <Text style={styles.pinError}>{error}</Text> : null}
            {checking && !error ? <Text style={styles.pinChecking}>Verificando…</Text> : null}
          </View>

          {provisioned && biometricAvailable && !biometricEnabled ? (
            <Pressable
              onPress={() => setBiometricToggle((v) => !v)}
              testID="biometric-toggle"
              style={styles.biometricToggle}
            >
              <Ionicons
                name={biometricToggle ? "checkbox" : "square-outline"}
                size={18}
                color={biometricToggle ? COLORS.accent : COLORS.faint}
              />
              <Text style={styles.biometricToggleLabel}>
                Usar biometria para desbloquear
              </Text>
            </Pressable>
          ) : null}

          <View style={styles.keypad}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <Pressable
                key={d}
                onPress={() => pressDigit(d)}
                disabled={checking}
                style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              >
                <Text style={styles.keyLabel}>{d}</Text>
              </Pressable>
            ))}
            {provisioned ? (
              biometricEnabled && biometricAvailable ? (
                <Pressable
                  onPress={onBiometricUnlock}
                  disabled={checking || biometricBusy}
                  testID="biometric-unlock"
                  style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
                >
                  {biometricBusy ? (
                    <ActivityIndicator color={COLORS.accent} size="small" />
                  ) : (
                    <Ionicons name="finger-print-outline" size={24} color={COLORS.accent} />
                  )}
                </Pressable>
              ) : (
                <View style={styles.key} />
              )
            ) : (
              <Pressable onPress={backToSelect} style={styles.key}>
                <Text style={styles.keyActionLabel}>Voltar</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => pressDigit("0")}
              disabled={checking}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Text style={styles.keyLabel}>0</Text>
            </Pressable>
            <Pressable
              onPress={backspace}
              disabled={checking || pin.length === 0}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Ionicons
                name="backspace-outline"
                size={22}
                color={pin.length === 0 ? COLORS.faint : COLORS.muted}
              />
            </Pressable>
          </View>

          <Pressable
            onPress={confirmPin}
            disabled={checking || pin.length < MIN_PIN}
            style={({ pressed }) => [styles.enterButton, pressed && styles.enterButtonPressed]}
          >
            {checking ? (
              <ActivityIndicator color={COLORS.accentForeground} size="small" />
            ) : (
              <Text style={styles.enterLabel}>Entrar</Text>
            )}
          </Pressable>

          {provisioned ? (
            <Pressable
              onPress={() => navigation?.navigate?.("Setup")}
              style={({ pressed }) => [styles.serverRow, pressed && styles.serverRowPressed]}
            >
              <Ionicons name="server-outline" size={12} color={COLORS.faint} />
              <Text style={styles.serverLabel} numberOfLines={1}>
                Servidor: {currentServerLabel()}
                {serverTag ? ` v${serverTag}` : ""}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  select: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  selectContent: {
    padding: 24,
    paddingBottom: 40,
  },
  selectHeader: {
    alignItems: "center",
    marginBottom: 28,
    gap: 10,
  },
  logoMock: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  storeName: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: "800",
  },
  selectSubtitle: {
    color: COLORS.faint,
    fontSize: 13,
  },
  spinner: {
    marginTop: 32,
  },
  loadError: {
    color: COLORS.danger,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 40,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  userCard: {
    width: "48%",
    backgroundColor: COLORS.surface,
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  userCardPressed: {
    borderColor: COLORS.accent,
  },
  userName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
  userRole: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  userRoleLabel: {
    color: COLORS.faint,
    fontSize: 12,
  },
  serverRow: {
    marginTop: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  serverRowPressed: {
    opacity: 0.6,
  },
  serverLabel: {
    color: COLORS.faint,
    fontSize: 12,
  },

  pinScreen: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    padding: 24,
  },
  pinHeader: {
    alignItems: "center",
    marginBottom: 20,
    gap: 6,
  },
  pinName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 6,
  },
  pinSubtitle: {
    color: COLORS.faint,
    fontSize: 14,
  },
  dotsRow: {
    height: 44,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotEmpty: {
    backgroundColor: COLORS.surfaceBorder,
  },
  dotFilled: {
    backgroundColor: COLORS.accent,
  },
  dotError: {
    backgroundColor: COLORS.danger,
  },
  // Input transparente por cima dos pontos: é ele que abre o teclado do
  // aparelho; os pontos continuam sendo a leitura visual.
  pinInput: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
  },
  pinFeedback: {
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  pinError: {
    color: COLORS.danger,
    fontSize: 12,
    fontWeight: "600",
  },
  pinChecking: {
    color: COLORS.faint,
    fontSize: 12,
  },
  biometricToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 12,
  },
  biometricToggleLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  keypad: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  key: {
    width: "29%",
    flexGrow: 1,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: {
    backgroundColor: COLORS.surfaceBorder,
  },
  keyLabel: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: "700",
  },
  keyActionLabel: {
    color: COLORS.faint,
    fontSize: 12,
    fontWeight: "600",
  },
  enterButton: {
    marginTop: 20,
    backgroundColor: COLORS.accent,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  enterButtonPressed: {
    backgroundColor: "#fbbf24dd",
  },
  enterLabel: {
    color: COLORS.accentForeground,
    fontSize: 16,
    fontWeight: "700",
  },
});