// Seleção de variações de um produto — porta RN do VariationModal web
// (frontend/src/entities/product/ui/VariationModal.jsx). Overlay central; o
// garçom só escolhe as opções (observação fica na revisão do carrinho).
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatBRL } from "@/shared/lib";
import { missingRequiredGroups, variationGroups } from "../model/cartLogic.js";
import OverlayModal from "./OverlayModal.jsx";

export default function VariationModal({ product, onClose, onConfirm }) {
  const groups = variationGroups(product);
  const [selected, setSelected] = useState({});
  const [missing, setMissing] = useState([]);

  function toggleOption(group, option) {
    setSelected((prev) => {
      const current = prev[group.name];
      if (group.allowMultiple) {
        const arr = Array.isArray(current) ? current : [];
        const next = arr.includes(option) ? arr.filter((o) => o !== option) : [...arr, option];
        return { ...prev, [group.name]: next };
      }
      return { ...prev, [group.name]: current === option ? undefined : option };
    });
  }

  function isSelected(group, option) {
    const v = selected[group.name];
    return Array.isArray(v) ? v.includes(option) : v === option;
  }

  function isSatisfied(group) {
    if (!group.required) return true;
    const v = selected[group.name];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  }

  function handleConfirm() {
    const missingGroups = missingRequiredGroups(groups, selected);
    if (missingGroups.length > 0) {
      setMissing(missingGroups);
      return;
    }
    const sel = {};
    for (const g of groups) {
      const v = selected[g.name];
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      sel[g.name] = v;
    }
    onConfirm(sel);
  }

  return (
    <OverlayModal
      title={product.name}
      subtitle={typeof product.price === "number" ? formatBRL(product.price) : undefined}
      onClose={onClose}
      footer={
        <Pressable onPress={handleConfirm} style={styles.confirmButton} accessibilityRole="button">
          <Text style={styles.confirmLabel}>Adicionar</Text>
        </Pressable>
      }
    >
      <View style={styles.groups}>
        {groups.map((g) => {
          const missingGroup = missing.includes(g.name) && !isSatisfied(g);
          return (
            <View key={g.name} style={styles.group}>
              <Text style={styles.groupName}>
                {g.name}
                {g.required ? <Text style={styles.required}> *</Text> : null}
                {g.allowMultiple && !g.required ? <Text style={styles.multi}> (vários)</Text> : null}
              </Text>
              <View style={styles.options}>
                {g.options.map((opt) => {
                  const active = isSelected(g, opt);
                  return (
                    <Pressable
                      key={opt}
                      onPress={() => toggleOption(g, opt)}
                      style={[
                        styles.option,
                        active && styles.optionActive,
                        missingGroup && !isSatisfied(g) && styles.optionMissing,
                      ]}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>{opt}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {missingGroup && <Text style={styles.missingHint}>Selecione uma opção obrigatória.</Text>}
            </View>
          );
        })}
      </View>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  groups: {
    gap: 16,
  },
  group: {
    gap: 10,
  },
  groupName: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "700",
  },
  required: {
    color: "#fbbf24",
  },
  multi: {
    color: "#78716c",
    fontSize: 13,
    fontWeight: "400",
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  option: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#292524",
  },
  optionActive: {
    backgroundColor: "#f59e0b",
    borderColor: "#f59e0b",
  },
  optionMissing: {
    borderColor: "#ef4444",
  },
  optionLabel: {
    color: "#e7e5e4",
    fontSize: 13,
    fontWeight: "500",
  },
  optionLabelActive: {
    color: "#1c1917",
  },
  missingHint: {
    color: "#f87171",
    fontSize: 12,
  },
  confirmButton: {
    backgroundColor: "#f59e0b",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  confirmLabel: {
    color: "#1c1917",
    fontSize: 15,
    fontWeight: "700",
  },
});