// Porta do StatusBadge do web (frontend/src/entities/order/ui/StatusBadge.jsx).
import { StyleSheet, Text, View } from "react-native";

const STATUS_LABEL = { ordered: "Em preparo", ready: "Pronto", delivered: "Entregue", cancelled: "Cancelado" };
const STATUS_COLOR = {
  ordered: { bg: "#44403c", fg: "#d6d3d1" }, // stone-700 em stone-300
  ready: { bg: "#10b981", fg: "#022c22" }, // emerald-500 em emerald-950
  delivered: { bg: "#292524", fg: "#78716c" }, // stone-800 em stone-500
  cancelled: { bg: "#450a0a", fg: "#f87171" }, // red-950 em red-400
};
const DEFAULT_COLOR = STATUS_COLOR.ordered;

export default function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] ?? DEFAULT_COLOR;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.label, { color: c.fg }]}>{STATUS_LABEL[status] ?? status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
  },
});