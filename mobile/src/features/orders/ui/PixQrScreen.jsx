// QR do Pix — porta RN do PixQrScreen web, trocando o canvas (`qrcode` pkg)
// pelo react-native-qrcode-svg (o payload do BR Code é só string — sem
// geração de imagem). `warnings` vêm de analyzePixKey/buildPixPayload.
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "react-native-qrcode-svg";
import { formatBRL } from "@/shared/lib";
import { orderLabel, orderTotal } from "@/entities/order";
import { analyzePixKey, buildPixPayload } from "../model/pix.js";

export default function PixQrScreen({ order, amount, storeSettings, onBack, onConfirm, submitting }) {
  const value = amount ?? orderTotal(order);
  const { warnings } = analyzePixKey(storeSettings.pixKey, storeSettings.pixKeyType);
  const payload = buildPixPayload({
    pixKey: storeSettings.pixKey,
    pixKeyType: storeSettings.pixKeyType,
    merchantName: storeSettings.merchantName,
    merchantCity: storeSettings.merchantCity,
    amount: value,
    txid: order.id,
    description: orderLabel(order),
  });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <Text style={styles.hint}>Escaneie o QR com o app do banco</Text>
        <Text style={styles.amount}>{formatBRL(value)}</Text>
      </View>
      <View style={styles.qrBox}>
        <View style={styles.qrFrame}>
          <QRCode value={payload} size={200} backgroundColor="#ffffff" color="#000000" />
        </View>
      </View>
      <Text style={styles.hint}>Confira o recebimento no extrato do banco antes de confirmar.</Text>
      {warnings.length > 0 && (
        <View style={styles.warnBox}>
          {warnings.map((w) => (
            <View key={w} style={styles.warnRow}>
              <Ionicons name="alert-circle" size={14} color="#fbbf24" />
              <Text style={styles.warnText}>{w}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.actions}>
        <Pressable onPress={onBack} style={[styles.button, styles.back]} accessibilityRole="button">
          <Text style={styles.backLabel}>Voltar</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={submitting}
          style={[styles.button, styles.confirm, submitting && styles.confirmDisabled]}
          accessibilityRole="button"
        >
          <Text style={styles.confirmLabel}>{submitting ? "Confirmando…" : "Confirmar recebimento"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    paddingVertical: 8,
  },
  head: {
    alignItems: "center",
    gap: 4,
  },
  hint: {
    color: "#a8a29e",
    fontSize: 13,
    textAlign: "center",
    marginTop: 8,
    marginBottom: 8,
  },
  amount: {
    color: "#34d399",
    fontSize: 30,
    fontWeight: "800",
  },
  qrBox: {
    marginVertical: 8,
  },
  qrFrame: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 10,
  },
  warnBox: {
    alignSelf: "stretch",
    backgroundColor: "rgba(245,158,11,0.1)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    borderRadius: 12,
    padding: 12,
    gap: 6,
    marginBottom: 12,
  },
  warnRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  warnText: {
    flex: 1,
    color: "#fcd34d",
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: 10,
  },
  button: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  back: {
    backgroundColor: "#292524",
  },
  backLabel: {
    color: "#d6d3d1",
    fontSize: 15,
    fontWeight: "600",
  },
  confirm: {
    backgroundColor: "#10b981",
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmLabel: {
    color: "#022c22",
    fontSize: 15,
    fontWeight: "700",
  },
});