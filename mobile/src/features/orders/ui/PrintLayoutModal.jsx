// Escolha do layout de impressão — porta RN do PrintLayoutModal web.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import OverlayModal from "./OverlayModal.jsx";

const LAYOUTS = [
  { id: "kitchen", label: "Cozinha", description: "Ticket de produção para a cozinha", icon: "restaurant-outline" },
  { id: "courier", label: "Entrega", description: "Ticket com endereço para o entregador", icon: "bicycle-outline" },
];

export default function PrintLayoutModal({ onClose, onPrint, busy }) {
  return (
    <OverlayModal title="Imprimir pedido" onClose={onClose}>
      <Text style={styles.hint}>Escolha o layout de impressão:</Text>
      <View style={styles.list}>
        {LAYOUTS.map((layout) => (
          <Pressable
            key={layout.id}
            disabled={busy}
            onPress={() => onPrint(layout.id)}
            style={styles.row}
            accessibilityRole="button"
          >
            <Ionicons name={layout.icon} size={22} color="#f59e0b" />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{layout.label}</Text>
              <Text style={styles.rowDesc}>{layout.description}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  hint: {
    color: "#a8a29e",
    fontSize: 14,
    marginBottom: 12,
  },
  list: {
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(41,37,36,0.6)",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    padding: 14,
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "600",
  },
  rowDesc: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 2,
  },
});