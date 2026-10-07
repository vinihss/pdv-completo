// Confirmação destrutiva (porta do `ConfirmModal` do web). Usa o OverlayModal
// compartilhado; o botão de confirmação é vermelho.
import { Pressable, StyleSheet, Text, View } from "react-native";
import OverlayModal from "./OverlayModal.jsx";

export default function ConfirmModal({ title, message, confirmLabel = "Confirmar", destructive = false, onCancel, onConfirm }) {
  return (
    <OverlayModal title={title} onClose={onCancel}>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        <Pressable onPress={onCancel} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelLabel}>Cancelar</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          style={destructive ? styles.confirmDanger : styles.confirm}
          accessibilityRole="button"
        >
          <Text style={styles.confirmLabel}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  message: {
    color: "#d6d3d1", // stone-300
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },
  cancel: {
    flex: 1,
    backgroundColor: "#292524", // stone-800
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelLabel: {
    color: "#d6d3d1",
    fontSize: 15,
    fontWeight: "600",
  },
  confirm: {
    flex: 1,
    backgroundColor: "#f59e0b", // amber-500
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmDanger: {
    flex: 1,
    backgroundColor: "#dc2626", // red-600
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmLabel: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "700",
  },
});