// Novo (não existe no web — lá o servidor é um modal que recarrega a página).
// Única tela de "para onde o app fala". Funciona nos dois ramos:
//   - boot sem servidor: o RootNavigator monta só Setup; salvar (applyServer)
//     troca `configured` para true e o root vira Login automaticamente —
//     aqui nem precisamos navegar (navigation.canGoBack() é false).
//   - já configurado (veio de Login): salvar volta para o Login com goBack.
//
// O teste do servidor é um ping real ANTES de gravar: config global temporária
// → pingApi() → se ok, applyServer persiste; se falhar, restaura a config
// anterior e mostra o erro. A config global é que é o perigo aqui — por isso
// o bloco try/finally devolve o estado anterior em qualquer falha.
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { pingApi } from "@/shared/api/http";
import { normalizeOrigin, setAppConfig } from "@/shared/lib/appConfig";
import { getDaemonBase, getServerBase } from "@/shared/lib/server";
import { useAppConfig } from "@/app/providers/appConfig";
import { COLORS } from "@/shared/lib/theme";

export default function SetupPage({ navigation }) {
  const { configured, applyServer } = useAppConfig();
  const [draft, setDraft] = useState(getServerBase());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const originHint = useMemo(
    () =>
      draft && draft.trim().length > 0 ? normalizeOrigin(draft.trim()) : "",
    [draft],
  );

  async function save() {
    if (saving) return;
    const normalized = normalizeOrigin(draft);
    if (!normalized) {
      setError("Informe o endereço do servidor.");
      return;
    }

    setSaving(true);
    setError(null);

    // Servidor anterior (se houver) para restaurar caso o ping falhe.
    const prev = { apiBase: getServerBase(), daemonUrl: getDaemonBase() };
    setAppConfig({ apiBase: normalized, daemonUrl: prev.daemonUrl });

    try {
      const ok = await pingApi();
      if (!ok) throw new Error("servidor não respondeu");
      const result = applyServer(normalized);
      if (!result.ok) throw new Error(result.error ?? "valor inválido");
      // Configurado: quem estava no root de boot some sozinho (configured vira
      // true). Quem veio de Login volta para o começo do fluxo.
      if (navigation.canGoBack()) navigation.goBack();
    } catch {
      setAppConfig(prev); // restaura a config anterior (ou o estado "nenhum")
      setError(
        `Não foi possível conectar em ${normalized}. Verifique o endereço e a rede da loja.`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Servidor</Text>
        <Text style={styles.subtitle}>
          Endereço do backend da loja. É dele que o app baixa o cardápio, as comandas e as
          entregas.
        </Text>

        <TextInput
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            setError(null);
          }}
          placeholder="https://app.seudominio.com.br"
          placeholderTextColor={COLORS.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, error && styles.inputError]}
        />

        {originHint ? (
          <Text style={styles.hint}>Vai usar: {originHint}</Text>
        ) : (
          <Text style={styles.hint}>
            Rede local da loja: use o IP da máquina, ex. http://192.168.0.10:3000
          </Text>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          {configured ? (
            <Pressable
              onPress={() => navigation.goBack()}
              disabled={saving}
              style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.cancelLabel}>Cancelar</Text>
            </Pressable>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Pressable
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [styles.button, styles.saveButton, pressed && styles.buttonPressed]}
          >
            {saving ? (
              <ActivityIndicator color={COLORS.accentForeground} size="small" />
            ) : (
              <Text style={styles.saveLabel}>Salvar</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    padding: 24,
  },
  content: {
    gap: 12,
  },
  title: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: "800",
  },
  subtitle: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    marginTop: 8,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: COLORS.text,
    fontSize: 15,
  },
  inputError: {
    borderColor: COLORS.danger,
  },
  hint: {
    color: COLORS.faint,
    fontSize: 12,
  },
  error: {
    color: COLORS.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  cancelButton: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.surfaceBorder,
    borderWidth: 1,
  },
  cancelLabel: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: "600",
  },
  saveButton: {
    backgroundColor: COLORS.accent,
  },
  saveLabel: {
    color: COLORS.accentForeground,
    fontSize: 15,
    fontWeight: "700",
  },
});