// Nova comanda — porta RN do NewOrderModal web. Virou tela (apresentação
// modal no stack) em vez de overlay: 3 abas (mesa/cliente/rótulo).
// Mora em `pages/garcon` (e não em `features/orders` como as irmãs AddItem e
// Payment) porque precisa do estado compartilhado da lista: criar a comanda via
// `createOrder` do OrderFlowProvider já deixa a comanda na lista do board,
// senão o detalhe abria com "Comanda não encontrada." até o GET de foco voltar.
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/app/providers/auth";
import { useOrderFlow } from "@/widgets/order-board/OrderFlowProvider.jsx";
import { listTables, searchCustomers, createCustomer } from "@/features/orders/api/catalog.js";

export default function NewOrderScreen({ navigation }) {
  const { storeSettings } = useAuth();
  const usesTables = storeSettings?.usesTables ?? true;
  const { createOrder } = useOrderFlow();

  const [mode, setMode] = useState(usesTables ? "table" : "tab");
  const [tableId, setTableId] = useState("");
  const [tables, setTables] = useState([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [tabLabel, setTabLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const searchTimer = useRef(null);

  useEffect(() => {
    if (usesTables) {
      listTables()
        .then(setTables)
        .catch(() => {});
    }
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [usesTables]);

  useEffect(() => {
    if (mode !== "customer" || !customerQuery) {
      setCustomerResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchCustomers(customerQuery)
        .then(setCustomerResults)
        .catch(() => {});
    }, 250);
  }, [mode, customerQuery]);

  async function handleConfirm() {
    setError(null);
    let identification = {};
    if (mode === "table") {
      if (!tableId) return setError("Selecione uma mesa.");
      identification = { tableId };
    } else if (mode === "customer") {
      if (!selectedCustomer) return setError("Selecione ou cadastre um cliente.");
      identification = { customerId: selectedCustomer.id };
    } else {
      if (!tabLabel.trim()) return setError("Informe um rótulo para a comanda.");
      identification = { tabLabel: tabLabel.trim() };
    }
    setSubmitting(true);
    try {
      const order = await createOrder(identification);
      navigation.replace("Detail", { orderId: order.id });
    } catch (e) {
      setSubmitting(false);
      setError(e.message);
    }
  }

  async function handleQuickCreateCustomer() {
    if (!customerQuery.trim()) return;
    try {
      const created = await createCustomer({ name: customerQuery.trim() });
      setSelectedCustomer(created);
      setCustomerResults([]);
    } catch (e) {
      setError(e.message);
    }
  }

  const tabs = [
    ...(usesTables ? [{ id: "table", label: "Mesa" }] : []),
    { id: "customer", label: "Cliente" },
    { id: "tab", label: "Rótulo" },
  ];

  return (
    <View style={styles.screen}>
      <View style={styles.tabs}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setMode(t.id)}
            style={[styles.tab, mode === t.id && styles.tabActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabLabel, mode === t.id && styles.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {mode === "table" && (
        <FlatList
          data={tables}
          keyExtractor={(t) => t.id}
          numColumns={4}
          contentContainerStyle={styles.tableGrid}
          renderItem={({ item: t }) => {
            const occupied = t.status === "occupied";
            const active = tableId === t.id;
            return (
              <Pressable
                disabled={occupied}
                onPress={() => setTableId(t.id)}
                style={[styles.table, active && styles.tableActive, occupied && styles.tableOccupied]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.tableLabel,
                    active && styles.tableLabelActive,
                    occupied && styles.tableLabelOccupied,
                  ]}
                >
                  {t.number}
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      {mode === "customer" && (
        <View style={styles.customerPane}>
          <TextInput
            value={customerQuery}
            onChangeText={(v) => {
              setCustomerQuery(v);
              setSelectedCustomer(null);
            }}
            placeholder="Nome do cliente..."
            placeholderTextColor="#57534e"
            style={styles.input}
          />
          {selectedCustomer ? (
            <View style={styles.selectedBox}>
              <Text style={styles.selectedName}>{selectedCustomer.name}</Text>
              <Pressable onPress={() => setSelectedCustomer(null)} hitSlop={8} accessibilityLabel="Remover cliente selecionado">
                <Ionicons name="close-circle" size={18} color="#a8a29e" />
              </Pressable>
            </View>
          ) : (
            <View>
              {customerResults.map((c) => (
                <Pressable key={c.id} onPress={() => setSelectedCustomer(c)} style={styles.resultRow} accessibilityRole="button">
                  <Text style={styles.resultName}>
                    {c.name}
                    {c.phone ? <Text style={styles.resultPhone}> · {c.phone}</Text> : null}
                  </Text>
                </Pressable>
              ))}
              {customerQuery && customerResults.length === 0 && (
                <Pressable onPress={handleQuickCreateCustomer} style={styles.resultRow} accessibilityRole="button">
                  <Text style={styles.resultCreate}>+ Cadastrar &quot;{customerQuery}&quot;</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}

      {mode === "tab" && (
        <View style={styles.tabPane}>
          <TextInput
            value={tabLabel}
            onChangeText={setTabLabel}
            placeholder="Ex: Comanda 12"
            placeholderTextColor="#57534e"
            style={styles.input}
          />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.footer}>
        <Pressable onPress={handleConfirm} disabled={submitting} style={[styles.confirm, submitting && styles.confirmDisabled]}>
          <Text style={styles.confirmLabel}>{submitting ? "Abrindo…" : "Abrir comanda"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
    padding: 16,
    paddingBottom: 24,
  },
  tabs: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#292524",
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#f59e0b",
  },
  tabLabel: {
    color: "#a8a29e",
    fontSize: 14,
    fontWeight: "600",
  },
  tabLabelActive: {
    color: "#1c1917",
  },
  tableGrid: {
    gap: 10,
  },
  table: {
    flex: 1,
    margin: 4,
    paddingVertical: 18,
    borderRadius: 12,
    backgroundColor: "#292524",
    alignItems: "center",
    justifyContent: "center",
  },
  tableActive: {
    backgroundColor: "#f59e0b",
  },
  tableOccupied: {
    backgroundColor: "rgba(28,25,23,0.5)",
  },
  tableLabel: {
    color: "#e7e5e4",
    fontSize: 16,
    fontWeight: "800",
  },
  tableLabelActive: {
    color: "#1c1917",
  },
  tableLabelOccupied: {
    color: "#44403c",
  },
  customerPane: {
    gap: 8,
  },
  tabPane: {
    gap: 8,
  },
  input: {
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: "#fafaf9",
    fontSize: 14,
  },
  selectedBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(16,185,129,0.1)",
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.4)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  selectedName: {
    color: "#fafaf9",
    fontSize: 14,
  },
  resultRow: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1c1917",
  },
  resultName: {
    color: "#fafaf9",
    fontSize: 14,
  },
  resultPhone: {
    color: "#78716c",
  },
  resultCreate: {
    color: "#fbbf24",
    fontSize: 14,
  },
  error: {
    color: "#f87171",
    fontSize: 13,
    marginTop: 12,
  },
  footer: {
    marginTop: "auto",
  },
  confirm: {
    backgroundColor: "#f59e0b",
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmLabel: {
    color: "#1c1917",
    fontSize: 16,
    fontWeight: "700",
  },
});