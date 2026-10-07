// Revisão do carrinho antes de confirmar o lançamento — porta RN do
// ReviewCartModal web. A observação por item fica aqui.
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatBRL } from "@/shared/lib";
import { variationsText } from "@/entities/order";
import OverlayModal from "./OverlayModal.jsx";

export default function ReviewCartModal({ lines, total, onClose, onRemoveLine, onChangeNotes, onConfirm }) {
  return (
    <OverlayModal
      title="Revisar itens"
      onClose={onClose}
      footer={
        <View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatBRL(total)}</Text>
          </View>
          <Pressable onPress={onConfirm} style={styles.confirmButton} accessibilityRole="button">
            <Text style={styles.confirmLabel}>Confirmar lançamento</Text>
          </Pressable>
        </View>
      }
    >
      <ScrollView contentContainerStyle={styles.list}>
        {lines.map((line, idx) => {
          const key = line.key;
          const variation = variationsText(line.selectedVariations);
          return (
            <View key={key ?? idx} style={styles.line}>
              <View style={styles.lineTop}>
                <View style={styles.lineHead}>
                  <Text style={styles.lineTitle}>
                    {line.quantity}× {line.product.name}
                  </Text>
                  {variation ? <Text style={styles.lineVariation}>{variation}</Text> : null}
                </View>
                <View style={styles.lineRight}>
                  <Text style={styles.lineTotal}>{formatBRL(line.product.price * line.quantity)}</Text>
                  <Pressable
                    onPress={() => onRemoveLine(key)}
                    hitSlop={8}
                    accessibilityLabel={`Remover ${line.product.name}`}
                  >
                    <Ionicons name="trash-outline" size={16} color="#78716c" />
                  </Pressable>
                </View>
              </View>
              <TextInput
                value={line.notes ?? ""}
                onChangeText={(v) => onChangeNotes(key, v)}
                placeholder="Observações (ex.: sem cebola, ponto mal passado)"
                placeholderTextColor="#57534e"
                style={styles.notesInput}
              />
            </View>
          );
        })}
      </ScrollView>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 10,
    paddingBottom: 8,
  },
  line: {
    backgroundColor: "rgba(41,37,36,0.6)",
    borderRadius: 12,
    padding: 12,
  },
  lineTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  lineHead: {
    flex: 1,
  },
  lineTitle: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "600",
  },
  lineVariation: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 2,
  },
  lineRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  lineTotal: {
    color: "#34d399",
    fontSize: 14,
    fontWeight: "600",
  },
  notesInput: {
    marginTop: 10,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#fafaf9",
    fontSize: 13,
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  totalLabel: {
    color: "#a8a29e",
    fontSize: 14,
  },
  totalValue: {
    color: "#34d399",
    fontSize: 20,
    fontWeight: "700",
  },
  confirmButton: {
    backgroundColor: "#10b981",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  confirmLabel: {
    color: "#022c22",
    fontSize: 15,
    fontWeight: "700",
  },
});