// Overlay central (porta do `Modal` compartilhado do web, frontend/src/shared/
// components/Modal.jsx). Dono da sobreposição — nada de `position: absolute`
// ad hoc no fluxo. Título no topo, X de fechar, conteúdo e rodapé fixo.
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

export default function OverlayModal({ title, subtitle, onClose, children, footer, visible = true }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} style={styles.close} hitSlop={8} accessibilityLabel="Fechar" accessibilityRole="button">
              <Ionicons name="close" size={20} color="#a8a29e" />
            </Pressable>
          </View>
          <View style={styles.body}>{children}</View>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: "#1c1917", // stone-900
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#44403c", // stone-700
    overflow: "hidden",
    maxHeight: "85%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#292524", // stone-800
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  title: {
    color: "#fafaf9",
    fontSize: 17,
    fontWeight: "700",
  },
  subtitle: {
    color: "#78716c",
    fontSize: 13,
    marginTop: 1,
  },
  close: {
    padding: 4,
  },
  body: {
    padding: 16,
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    backgroundColor: "#171412",
  },
});