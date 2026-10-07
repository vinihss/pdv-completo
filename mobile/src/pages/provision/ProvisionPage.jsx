// Tela de provisionamento — primeiro acesso do aparelho (docs/21-device-provisioning.md
// §5.2). Sem credencial, o app não mostra a grade de usuários: mostra o scanner
// de QR (`expo-camera`) e a digitação da chave. O código vem do gerente (email
// com QR) e o exchange devolve {deviceId, deviceToken, user}, guardado no
// SecureStore pelo AuthProvider — a partir daí a tela de PIN do usuário
// vinculado aparece (RootNavigator).
//
// Paleta igual à do login (theme.js): fundo #0c0a09, cards #1c1917, destaque
// #fbbf24, ícones Ionicons.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { CameraView, useCameraPermissions } from "expo-camera";
import { useAuth } from "@/app/providers/auth";
import {
  canonicalProvisioningCode,
  formatProvisioningCode,
  maskProvisioningCodeInput,
  parseQrPayload,
  provisioningCodeBody,
  provisioningErrorMessage,
} from "@/entities/provisioning";
import { COLORS } from "@/shared/lib/theme";
import { currentServerLabel } from "@/shared/lib/server";

export default function ProvisionPage({ navigation }) {
  const { provision } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState("scan"); // scan | manual
  const [code, setCode] = useState(""); // corpo digitado (com grupos)
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [scanned, setScanned] = useState(false);
  const alertedRef = useRef(null);

  // Pede a câmera ao abrir o scanner (uma vez por sessão de tela). O usuário
  // pode adiar e digitar o código — o fallback existe sempre.
  useEffect(() => {
    if (mode !== "scan" || !permission || permission.granted) return;
    if (!permission.canAskAgain) return;
    if (alertedRef.current) return;
    alertedRef.current = true;
    requestPermission();
  }, [mode, permission, requestPermission]);

  const submit = useCallback(
    async (rawCode) => {
      const body = provisioningCodeBody(rawCode);
      if (body.length < 16) {
        setError("Digite a chave completa (PDV-XXXX-XXXX-XXXX-XXXX).");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        // Sucesso: o AuthProvider grava a credencial e o RootNavigator troca a
        // árvore para a tela de PIN do usuário vinculado. Não navega aqui.
        await provision(canonicalProvisioningCode(rawCode));
      } catch (e) {
        setScanned(false);
        setSubmitting(false);
        setError(provisioningErrorMessage(e));
      }
    },
    [provision],
  );

  const onBarcodeScanned = useCallback(
    ({ data }) => {
      if (scanned || submitting) return;
      const parsed = parseQrPayload(data);
      if (!parsed || provisioningCodeBody(parsed).length < 16) {
        setError("Este QR Code não é uma chave de provisionamento do PDV.");
        return;
      }
      setScanned(true);
      submit(parsed);
    },
    [scanned, submitting, submit],
  );

  const complete = provisioningCodeBody(code).length >= 16;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.logoMock}>
            <Ionicons name="qr-code-outline" size={28} color={COLORS.accentForeground} />
          </View>
          <Text style={styles.title}>Provisionar aparelho</Text>
          <Text style={styles.subtitle}>
            Leia o QR Code ou digite a chave que o gerente enviou para este usuário.
          </Text>
        </View>

        <View style={styles.tabs}>
          <Pressable
            onPress={() => {
              setMode("scan");
              setError(null);
            }}
            style={[styles.tab, mode === "scan" && styles.tabActive]}
          >
            <Ionicons
              name="scan-outline"
              size={16}
              color={mode === "scan" ? COLORS.accentForeground : COLORS.muted}
            />
            <Text style={[styles.tabLabel, mode === "scan" && styles.tabLabelActive]}>
              Escanear QR
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setMode("manual");
              setError(null);
            }}
            style={[styles.tab, mode === "manual" && styles.tabActive]}
          >
            <Ionicons
              name="keypad-outline"
              size={16}
              color={mode === "manual" ? COLORS.accentForeground : COLORS.muted}
            />
            <Text style={[styles.tabLabel, mode === "manual" && styles.tabLabelActive]}>
              Digitar código
            </Text>
          </Pressable>
        </View>

        {mode === "scan" ? (
          <View style={styles.scanBox}>
            {permission?.granted ? (
              <CameraView
                testID="provision-camera"
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={scanned || submitting ? undefined : onBarcodeScanned}
              />
            ) : (
              <View style={styles.scanFallback}>
                <Ionicons name="camera-outline" size={44} color={COLORS.faint} />
                <Text style={styles.scanHint}>
                  {permission && !permission.canAskAgain
                    ? "Sem permissão para usar a câmera."
                    : "Precisamos da câmera para ler o QR Code."}
                </Text>
                {permission?.canAskAgain ? (
                  <Pressable
                    onPress={() => requestPermission()}
                    style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryLabel}>Permitir câmera</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => setMode("manual")}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryLabel}>Digitar o código</Text>
                </Pressable>
              </View>
            )}
            {scanned || submitting ? (
              <View style={styles.scanOverlay}>
                <ActivityIndicator color={COLORS.accent} size="large" />
                <Text style={styles.scanOverlayText}>Validando chave…</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.manualBox}>
            <Text style={styles.fieldLabel}>Chave de provisionamento</Text>
            <View style={[styles.inputRow, error && styles.inputRowError]}>
              <Text style={styles.inputPrefix}>PDV-</Text>
              <TextInput
                value={code}
                onChangeText={(v) => {
                  setCode(maskProvisioningCodeInput(v));
                  setError(null);
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                placeholderTextColor={COLORS.faint}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.input}
              />
            </View>
            <Text style={styles.preview}>{formatProvisioningCode(code)}</Text>

            <Pressable
              onPress={() => submit(code)}
              disabled={!complete || submitting}
              style={({ pressed }) => [
                styles.primaryButton,
                (!complete || submitting) && styles.primaryButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={COLORS.accentForeground} size="small" />
              ) : (
                <Text style={styles.primaryLabel}>Conectar</Text>
              )}
            </Pressable>
          </View>
        )}

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={COLORS.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => navigation?.navigate?.("Setup")}
          style={({ pressed }) => [styles.serverRow, pressed && styles.pressed]}
        >
          <Ionicons name="server-outline" size={12} color={COLORS.faint} />
          <Text style={styles.serverLabel} numberOfLines={1}>
            Servidor: {currentServerLabel()}
          </Text>
        </Pressable>

        {__DEV__ ? (
          <Pressable
            onPress={() => navigation?.navigate?.("Login")}
            style={({ pressed }) => [styles.devLink, pressed && styles.pressed]}
          >
            <Text style={styles.devLinkText}>Entrar sem provisionar (dev)</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: 24,
    paddingBottom: 40,
    gap: 16,
  },
  header: {
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  logoMock: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: "800",
  },
  subtitle: {
    color: COLORS.faint,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  tabs: {
    flexDirection: "row",
    gap: 8,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.surfaceBorder,
    backgroundColor: COLORS.surface,
  },
  tabActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  tabLabel: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: "700",
  },
  tabLabelActive: {
    color: COLORS.accentForeground,
  },
  scanBox: {
    height: 280,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.surfaceBorder,
  },
  scanFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  scanHint: {
    color: COLORS.muted,
    fontSize: 13,
    textAlign: "center",
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(12,10,9,0.82)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  scanOverlayText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  manualBox: {
    gap: 10,
  },
  fieldLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  inputRowError: {
    borderColor: COLORS.danger,
  },
  inputPrefix: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 1,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1,
  },
  preview: {
    color: COLORS.faint,
    fontSize: 12,
    letterSpacing: 0.5,
  },
  primaryButton: {
    marginTop: 6,
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonDisabled: {
    opacity: 0.45,
  },
  primaryLabel: {
    color: COLORS.accentForeground,
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryButton: {
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  secondaryLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.12)",
    borderRadius: 12,
    padding: 12,
  },
  errorText: {
    flex: 1,
    color: COLORS.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  serverRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 4,
  },
  serverLabel: {
    color: COLORS.faint,
    fontSize: 12,
  },
  devLink: {
    alignItems: "center",
    paddingVertical: 8,
  },
  devLinkText: {
    color: COLORS.faint,
    fontSize: 12,
    textDecorationLine: "underline",
  },
  pressed: {
    opacity: 0.7,
  },
});
