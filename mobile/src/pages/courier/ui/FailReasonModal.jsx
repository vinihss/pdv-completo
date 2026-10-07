import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { FAIL_PRESETS } from "../model/failPresets";

export default function FailReasonModal({
  visible,
  deliveryId,
  onCancel,
  onConfirm,
  busy = false,
}) {
  const [reason, setReason] = useState("");
  const canConfirm = useMemo(() => reason.trim().length > 0, [reason]);

  const selectPreset = (preset) => {
    setReason(preset);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Registrar problema na entrega</Text>
          <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.closeButton}>
            <Ionicons name="close" size={22} color="#a8a29e" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <Text style={styles.sectionLabel}>Motivos rápidos</Text>
          <View style={styles.presets}>
            {FAIL_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset}
                onPress={() => selectPreset(preset)}
                style={[styles.presetButton, reason === preset && styles.presetActive]}
                disabled={busy}
              >
                <Text
                  style={[styles.presetText, reason === preset && styles.presetTextActive]}
                >
                  {preset}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Observação (obrigatória)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Descreva o motivo"
            placeholderTextColor="#78716c"
            multiline
            numberOfLines={4}
            style={styles.input}
            editable={!busy}
          />
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.cancelButton}>
            <Text style={styles.cancelText}>Cancelar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onConfirm(reason)}
            disabled={busy || !canConfirm}
            style={[styles.confirmButton, (!canConfirm || busy) && styles.confirmDisabled]}
          >
            <Text style={styles.confirmText}>
              {busy ? "Registrando…" : "Confirmar"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(12,10,9,0.72)",
  },
  container: {
    position: "absolute",
    left: 16,
    right: 16,
    top: "18%",
    backgroundColor: "#1c1917",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.32)",
    overflow: "hidden",
    maxHeight: "70%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(120,113,108,0.4)",
  },
  title: {
    color: "#fafaf9",
    fontSize: 16,
    fontWeight: "700",
  },
  closeButton: {
    padding: 6,
  },
  content: {
    maxHeight: 280,
  },
  contentContainer: {
    padding: 16,
    gap: 12,
  },
  sectionLabel: {
    color: "#d6d3d1",
    fontSize: 13,
    fontWeight: "600",
  },
  presets: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  presetButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(120,113,108,0.28)",
  },
  presetActive: {
    backgroundColor: "rgba(251,191,36,0.9)",
  },
  presetText: {
    color: "#e7e5e4",
    fontSize: 13,
    fontWeight: "600",
  },
  presetTextActive: {
    color: "#1c1917",
  },
  input: {
    minHeight: 88,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(120,113,108,0.4)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fafaf9",
    fontSize: 14,
    textAlignVertical: "top",
    backgroundColor: "rgba(28,25,23,0.9)",
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(120,113,108,0.4)",
  },
  cancelButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "rgba(120,113,108,0.28)",
  },
  cancelText: {
    color: "#e7e5e4",
    fontSize: 14,
    fontWeight: "600",
  },
  confirmButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#fbbf24",
    minHeight: 56,
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmText: {
    color: "#1c1917",
    fontSize: 15,
    fontWeight: "700",
  },
});
