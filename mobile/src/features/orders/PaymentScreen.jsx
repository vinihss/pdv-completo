// Pagamento da comanda — porta RN do PaymentModal web. Virou tela (apresentação
// modal) porque a navegação nativa não tem "portal". A comanda em si vem de
// GET /orders/:id (fonte da verdade) e, ao salvar/confirmar, volta — o
// detalhe recarrega ao ganhar foco.
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { getOrder, orderTotal, round2, setPayments, confirmPayment } from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import PixQrScreen from "./ui/PixQrScreen.jsx";

const PAYMENT_META = {
  cash: { label: "Dinheiro", icon: "cash-outline" },
  card: { label: "Cartão", icon: "card-outline" },
  pix: { label: "Pix", icon: "qr-code-outline" },
  other: { label: "Outro", icon: "ellipsis-horizontal" },
};

let uidSeq = 0;
function newLineId() {
  return `pl-${Date.now()}-${uidSeq++}`;
}

export default function PaymentScreen({ route, navigation }) {
  const orderId = route.params?.orderId;
  const enabledMethods = route.params?.enabledMethods ?? ["cash", "card", "pix", "other"];
  const storeSettings = route.params?.storeSettings ?? {};

  const [order, setOrder] = useState(null);
  const [lines, setLines] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [splitN, setSplitN] = useState(2);
  const [splitMethod, setSplitMethod] = useState(enabledMethods.includes("pix") ? "pix" : enabledMethods[0]);
  const [pixQueue, setPixQueue] = useState(null); // [{id, amount}] pendentes de confirmação

  const pixKey = (storeSettings.pixKey ?? "").trim();
  const pixKeyType = storeSettings.pixKeyType ?? null;
  const merchantName = (storeSettings.merchantName ?? "").trim();
  const merchantCity = (storeSettings.merchantCity ?? "").trim();
  const pixAvailable = Boolean(pixKey && merchantName && merchantCity);

  useFocusEffect(
    useCallback(() => {
      getOrder(orderId)
        .then((o) => {
          setOrder(o);
          setLines(
            (o.payments ?? []).map((p) => ({
              id: p.id,
              method: p.method,
              amount: String(p.amount ?? ""),
              received: p.received != null ? String(p.received) : String(p.amount ?? ""),
              confirmed: p.confirmed,
            }))
          );
          setPixQueue(null);
        })
        .catch(() => {});
    }, [orderId])
  );

  useEffect(() => {
    if (!order) return;
    if (enabledMethods.length > 0 && !enabledMethods.includes(splitMethod)) {
      setSplitMethod(enabledMethods[0]);
    }
  }, [order, enabledMethods, splitMethod]);

  if (!order) {
    return (
      <View style={styles.screen}>
        <Text style={styles.emptyText}>Carregando…</Text>
      </View>
    );
  }

  const total = orderTotal(order);
  const sumAmount = round2(lines.reduce((acc, l) => acc + (parseFloat(l.amount) || 0), 0));
  const remaining = round2(total - sumAmount);
  const balanced = Math.abs(remaining) < 0.005;

  const cashOk = lines.every((l) => {
    if (l.method !== "cash") return true;
    const amount = parseFloat(l.amount) || 0;
    const received = parseFloat(l.received) || 0;
    return received >= amount - 0.005;
  });

  const canSave = lines.length > 0 && balanced && cashOk && !submitting;

  function updateLine(id, patch) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addMethod(m) {
    setLines((prev) => [
      ...prev,
      {
        id: newLineId(),
        method: m,
        amount: Math.max(0, remaining).toFixed(2),
        received: Math.max(0, remaining).toFixed(2),
        confirmed: false,
      },
    ]);
  }

  function removeLine(id) {
    setLines((prev) => prev.filter((l) => l.id !== id));
  }

  function applySplit() {
    const n = Math.max(1, Math.min(20, splitN));
    const perHead = Math.floor((total * 100) / n) / 100;
    const next = [];
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const amount = isLast ? round2(total - perHead * (n - 1)) : perHead;
      next.push({
        id: newLineId(),
        method: splitMethod,
        amount: amount.toFixed(2),
        received: amount.toFixed(2),
        confirmed: false,
      });
    }
    setLines(next);
  }

  function remainingLabel() {
    if (lines.length === 0) return "Adicione uma ou mais formas de pagamento.";
    if (balanced) return "Valores conferem com o total da comanda.";
    if (remaining > 0) return `Falta R$ ${formatBRL(remaining)} para cobrir o total.`;
    return `Os valores excedem o total em R$ ${formatBRL(-remaining)}.`;
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      const payload = lines.map((l) => {
        const amount = round2(parseFloat(l.amount) || 0);
        const received = round2(parseFloat(l.received) || 0);
        return {
          method: l.method,
          amount,
          ...(l.method === "cash" ? { received } : {}),
          confirmed: l.method !== "pix",
        };
      });
      const saved = await setPayments(order.id, payload);
      const pendingPix = (saved.payments ?? []).filter((p) => p.method === "pix" && !p.confirmed);
      if (pendingPix.length > 0) {
        setPixQueue(pendingPix.map((p) => ({ id: p.id, amount: p.amount })));
      } else {
        navigation.goBack();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePixConfirm() {
    setSubmitting(true);
    try {
      await confirmPayment(order.id, pixQueue[0].id);
      if (pixQueue.length > 1) {
        setPixQueue(pixQueue.slice(1));
      } else {
        navigation.goBack();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (pixQueue) {
    const storeSettingsForPix = { pixKey, pixKeyType, merchantName, merchantCity };
    return (
      <View style={styles.screen}>
        <Text style={styles.pixTitle}>Pix{pixQueue.length > 1 ? ` (${pixQueue.length} restantes)` : ""}</Text>
        <PixQrScreen
          order={order}
          amount={pixQueue[0].amount}
          storeSettings={storeSettingsForPix}
          onBack={() => setPixQueue(null)}
          onConfirm={handlePixConfirm}
          submitting={submitting}
        />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content}>
      <View style={[styles.balanceBox, balanced ? styles.balanceOk : styles.balanceWarn]}>
        <Text style={[styles.balanceText, balanced ? styles.balanceTextOk : styles.balanceTextWarn]}>
          {remainingLabel()}
        </Text>
      </View>

      {lines.length > 0 && (
        <View style={styles.lines}>
          {lines.map((l) => {
            const meta = PAYMENT_META[l.method];
            const amount = parseFloat(l.amount) || 0;
            const received = parseFloat(l.received) || 0;
            const change = round2(received - amount);
            const cashShort = l.method === "cash" && change < -0.005;
            return (
              <View key={l.id} style={styles.line}>
                <View style={styles.lineHead}>
                  <Text style={styles.lineMethod}>
                    <Ionicons name={meta.icon} size={16} color="#fbbf24" /> {meta.label}
                  </Text>
                  <View style={styles.lineHeadRight}>
                    {l.confirmed && <Ionicons name="checkmark-circle" size={15} color="#34d399" />}
                    <Pressable onPress={() => removeLine(l.id)} hitSlop={8} accessibilityLabel={`Remover ${meta.label}`}>
                      <Ionicons name="trash-outline" size={15} color="#78716c" />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.inputs}>
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>Valor (R$)</Text>
                    <TextInput
                      value={l.amount}
                      onChangeText={(v) => updateLine(l.id, { amount: v })}
                      keyboardType="decimal-pad"
                      placeholder="0,00"
                      placeholderTextColor="#57534e"
                      style={styles.fieldInput}
                    />
                  </View>
                  {l.method === "cash" && (
                    <View style={styles.field}>
                      <Text style={[styles.fieldLabel, cashShort && styles.fieldLabelShort]}>
                        {cashShort ? `Faltam R$ ${formatBRL(-change)}` : "Recebido (R$)"}
                      </Text>
                      <TextInput
                        value={l.received}
                        onChangeText={(v) => updateLine(l.id, { received: v })}
                        keyboardType="decimal-pad"
                        placeholder="0,00"
                        placeholderTextColor="#57534e"
                        style={[styles.fieldInput, cashShort && styles.fieldInputShort]}
                      />
                    </View>
                  )}
                </View>
                {l.method === "cash" && !cashShort && change > 0.004 && (
                  <Text style={styles.troco}>Troco: {formatBRL(change)}</Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Adicionar forma de pagamento</Text>
        <View style={styles.methods}>
          {enabledMethods.map((m) => {
            const meta = PAYMENT_META[m];
            const disabled = m === "pix" && !pixAvailable;
            return (
              <Pressable
                key={m}
                disabled={disabled}
                onPress={() => addMethod(m)}
                style={[styles.method, disabled && styles.methodDisabled]}
                accessibilityRole="button"
              >
                <Ionicons name={meta.icon} size={20} color="#fbbf24" />
                <Text style={styles.methodLabel}>{meta.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {enabledMethods.includes("pix") && !pixAvailable && (
          <Text style={styles.pixHint}>
            Pix indisponível — configure a chave, o nome e a cidade nas Configurações do gerente.
          </Text>
        )}
      </View>

      <View style={styles.splitBox}>
        <Text style={styles.splitTitle}>Dividir igualmente entre</Text>
        <View style={styles.splitRow}>
          <Pressable onPress={() => setSplitN((n) => Math.max(1, n - 1))} style={styles.splitBtn} accessibilityLabel="Diminuir divisão">
            <Ionicons name="remove" size={15} color="#d6d3d1" />
          </Pressable>
          <Text style={styles.splitCount}>{splitN}</Text>
          <Pressable onPress={() => setSplitN((n) => Math.min(20, n + 1))} style={styles.splitBtn} accessibilityLabel="Aumentar divisão">
            <Ionicons name="add" size={15} color="#d6d3d1" />
          </Pressable>
          <View style={styles.splitMethods}>
            {enabledMethods.map((m) => {
              const disabled = m === "pix" && !pixAvailable;
              const active = splitMethod === m;
              return (
                <Pressable
                  key={m}
                  disabled={disabled}
                  onPress={() => setSplitMethod(m)}
                  style={[styles.splitMethod, active && styles.splitMethodActive, disabled && styles.methodDisabled]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.splitMethodLabel, active && styles.splitMethodLabelActive]}>{PAYMENT_META[m].label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <Pressable onPress={applySplit} disabled={total <= 0} style={[styles.splitApply, total <= 0 && styles.methodDisabled]}>
          <Text style={styles.splitApplyLabel}>Aplicar divisão</Text>
        </Pressable>
      </View>

      {!balanced && <Text style={styles.totalHint}>Ajuste os valores até que a soma bata com o total ({formatBRL(total)}).</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.footer}>
        <Pressable onPress={handleSave} disabled={!canSave} style={[styles.save, !canSave && styles.saveDisabled]}>
          <Text style={styles.saveLabel}>
            {submitting ? "Registrando…" : lines.some((l) => l.method === "pix") ? "Registrar e gerar Pix" : "Registrar pagamento"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
    padding: 20,
  },
  screenScroll: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  content: {
    padding: 16,
    paddingBottom: 32,
    gap: 16,
  },
  emptyText: {
    color: "#78716c",
    textAlign: "center",
    paddingTop: 48,
  },
  pixTitle: {
    color: "#fafaf9",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 8,
  },
  balanceBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  balanceOk: {
    backgroundColor: "rgba(16,185,129,0.1)",
    borderColor: "rgba(16,185,129,0.3)",
  },
  balanceWarn: {
    backgroundColor: "rgba(245,158,11,0.1)",
    borderColor: "rgba(245,158,11,0.3)",
  },
  balanceText: {
    fontSize: 13,
  },
  balanceTextOk: {
    color: "#34d399",
  },
  balanceTextWarn: {
    color: "#fbbf24",
  },
  lines: {
    gap: 10,
  },
  line: {
    backgroundColor: "rgba(41,37,36,0.6)",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    padding: 12,
  },
  lineHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  lineMethod: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "700",
  },
  lineHeadRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  inputs: {
    flexDirection: "row",
    gap: 10,
  },
  field: {
    flex: 1,
    gap: 4,
  },
  fieldLabel: {
    color: "#78716c",
    fontSize: 11,
  },
  fieldLabelShort: {
    color: "#f87171",
  },
  fieldInput: {
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#fafaf9",
    fontSize: 14,
  },
  fieldInputShort: {
    borderColor: "#ef4444",
    color: "#fca5a5",
  },
  troco: {
    color: "#34d399",
    fontSize: 12,
    marginTop: 8,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    color: "#78716c",
    fontSize: 13,
  },
  methods: {
    flexDirection: "row",
    gap: 10,
  },
  method: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    paddingVertical: 14,
  },
  methodDisabled: {
    opacity: 0.4,
  },
  methodLabel: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "600",
  },
  pixHint: {
    color: "#a8a29e",
    fontSize: 12,
  },
  splitBox: {
    backgroundColor: "rgba(41,37,36,0.6)",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  splitTitle: {
    color: "#d6d3d1",
    fontSize: 13,
    fontWeight: "600",
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  splitBtn: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 8,
    padding: 8,
  },
  splitCount: {
    width: 36,
    textAlign: "center",
    color: "#fafaf9",
    fontSize: 16,
    fontWeight: "800",
  },
  splitMethods: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    marginLeft: 4,
  },
  splitMethod: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#44403c",
    alignItems: "center",
  },
  splitMethodActive: {
    backgroundColor: "#f59e0b",
    borderColor: "#f59e0b",
  },
  splitMethodLabel: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "600",
  },
  splitMethodLabelActive: {
    color: "#1c1917",
  },
  splitApply: {
    backgroundColor: "#44403c",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  splitApplyLabel: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "600",
  },
  totalHint: {
    color: "#78716c",
    fontSize: 12,
    textAlign: "center",
  },
  error: {
    color: "#f87171",
    fontSize: 13,
  },
  footer: {
    marginTop: 4,
  },
  save: {
    backgroundColor: "#10b981",
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  saveDisabled: {
    opacity: 0.4,
  },
  saveLabel: {
    color: "#022c22",
    fontSize: 16,
    fontWeight: "700",
  },
});