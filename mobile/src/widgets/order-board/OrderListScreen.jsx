// Lista de comandas do garçom — porta RN do OrderListScreen web
// (frontend/src/widgets/order-board/OrderListScreen.jsx). Presentacional: os
// filtros/busca vivem no OrderBoard e a lógica de corte/ordem está em
// filterOrders.js (testada sem render).
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatBRL, formatDateTime } from "@/shared/lib";
import { orderLabel, orderTotal, orderHasReady, orderAllDelivered } from "@/entities/order";
import { emptyMessage, filterOrders, visibleChips } from "./filterOrders.js";

export default function OrderListScreen({
  orders,
  loading,
  error,
  kitchenEnabled,
  usesTables,
  filter,
  search,
  onFilter,
  onSearch,
  onOpenOrder,
  onNewOrder,
  onReloadAll,
}) {
  const chips = visibleChips(kitchenEnabled, usesTables);
  const filtered = filterOrders(orders, { filter, search });
  // Com lista em mãos a falha de atualização não pode esconder as comandas:
  // mostra o aviso e mantém os dados (stale) na tela.
  const showBanner = Boolean(error) && orders.length > 0;
  const showFatalError = Boolean(error) && orders.length === 0 && !loading;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          {/* O título "Comandas" mora no header nativo do stack (é lá que o sino
              fica); aqui sobra só o recarregar, alinhado à direita. */}
          <Pressable onPress={onReloadAll} hitSlop={8} accessibilityRole="button">
            <Text style={styles.reload}>Atualizar</Text>
          </Pressable>
        </View>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#57534e" />
          <TextInput
            value={search}
            onChangeText={onSearch}
            placeholder="Buscar por mesa, cliente..."
            placeholderTextColor="#57534e"
            style={styles.searchInput}
          />
        </View>
        <View style={styles.chips}>
          {chips.map((c) => {
            const active = filter === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => onFilter(c.id)}
                style={[styles.chip, active && styles.chipActive]}
                accessibilityRole="button"
              >
                <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{c.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {showBanner && (
        <View style={styles.banner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#fbbf24" />
          <Text style={styles.bannerText}>Não foi possível atualizar a lista.</Text>
          <Pressable onPress={onReloadAll} hitSlop={8} accessibilityRole="button">
            <Text style={styles.bannerRetry}>Tentar de novo</Text>
          </Pressable>
        </View>
      )}

      {loading && orders.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={styles.emptyText}>Carregando comandas…</Text>
        </View>
      ) : showFatalError ? (
        <View style={styles.centerBox}>
          <Ionicons name="cloud-offline-outline" size={26} color="#57534e" />
          <Text style={styles.errorTitle}>Não foi possível carregar as comandas.</Text>
          <Text style={styles.errorHint}>Confira a conexão com o servidor e tente de novo.</Text>
          <Pressable onPress={onReloadAll} style={styles.retryButton} accessibilityRole="button">
            <Ionicons name="refresh" size={16} color="#1c1917" />
            <Text style={styles.retryLabel}>Tentar de novo</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.centerBox}>
              <Text style={styles.emptyText}>{emptyMessage(filter)}</Text>
            </View>
          }
          renderItem={({ item: o }) => {
            const closed = o.status === "closed";
            const hasReady = orderHasReady(o);
            const allDelivered = orderAllDelivered(o);
            return (
              <Pressable
                onPress={() => !closed && onOpenOrder(o.id)}
                style={[styles.card, hasReady && styles.cardReady, closed && styles.cardClosed]}
                accessibilityRole="button"
                disabled={closed}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.cardTitle}>{orderLabel(o)}</Text>
                  <Text style={styles.cardCount}>
                    {o.items.length} {o.items.length === 1 ? "item" : "itens"}
                  </Text>
                </View>
                {(o.channel === "whatsapp" || o.channel === "web") && (
                  <Text style={styles.deliveryBadge}>
                    Delivery{o.channel === "whatsapp" ? " · WhatsApp" : ""}
                  </Text>
                )}
                <Text style={styles.cardTotal}>{formatBRL(orderTotal(o))}</Text>
                <Text style={styles.cardTime}>
                  Aberta em {formatDateTime(o.openedAt)}
                  {closed && <Text style={styles.cardTimeClosed}> · Fechada em {formatDateTime(o.closedAt)}</Text>}
                </Text>
                {kitchenEnabled && hasReady && (
                  <View style={styles.hintRow}>
                    <Ionicons name="flash" size={12} color="#34d399" />
                    <Text style={styles.hintReady}>Pronto para entregar</Text>
                  </View>
                )}
                {kitchenEnabled && allDelivered && !hasReady && (
                  <View style={styles.hintRow}>
                    <Ionicons name="checkmark" size={12} color="#78716c" />
                    <Text style={styles.hintDelivered}>Tudo entregue</Text>
                  </View>
                )}
              </Pressable>
            );
          }}
        />
      )}

      <Pressable style={styles.fab} onPress={onNewOrder} accessibilityLabel="Nova comanda" accessibilityRole="button">
        <Ionicons name="add" size={26} color="#1c1917" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09", // stone-950
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1c1917",
    backgroundColor: "#0c0a09",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginBottom: 10,
  },
  reload: {
    color: "#78716c",
    fontSize: 13,
    fontWeight: "600",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    color: "#fafaf9",
    fontSize: 14,
    paddingVertical: 9,
  },
  chips: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  chipActive: {
    backgroundColor: "#f59e0b",
    borderColor: "#f59e0b",
  },
  chipLabel: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "600",
  },
  chipLabelActive: {
    color: "#1c1917",
  },
  centerBox: {
    paddingVertical: 64,
    alignItems: "center",
  },
  emptyText: {
    color: "#57534e",
    fontSize: 14,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    backgroundColor: "rgba(245,158,11,0.1)",
  },
  bannerText: {
    flex: 1,
    color: "#fbbf24",
    fontSize: 12,
  },
  bannerRetry: {
    color: "#fafaf9",
    fontSize: 12,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  errorTitle: {
    color: "#d6d3d1",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 12,
    textAlign: "center",
  },
  errorHint: {
    color: "#57534e",
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: "#f59e0b",
  },
  retryLabel: {
    color: "#1c1917",
    fontSize: 14,
    fontWeight: "700",
  },
  listContent: {
    padding: 16,
    gap: 10,
    paddingBottom: 96,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#292524",
    backgroundColor: "#1c1917",
    padding: 14,
  },
  cardReady: {
    borderColor: "rgba(16,185,129,0.5)",
    backgroundColor: "rgba(16,185,129,0.06)",
  },
  cardClosed: {
    borderColor: "#292524",
    backgroundColor: "rgba(28,25,23,0.4)",
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  cardTitle: {
    color: "#fafaf9",
    fontSize: 18,
    fontWeight: "800",
  },
  cardCount: {
    color: "#78716c",
    fontSize: 12,
  },
  deliveryBadge: {
    alignSelf: "flex-start",
    fontSize: 10,
    fontWeight: "700",
    color: "#fbbf24",
    backgroundColor: "rgba(245,158,11,0.15)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 4,
    overflow: "hidden",
  },
  cardTotal: {
    color: "#34d399",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 6,
  },
  cardTime: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 2,
  },
  cardTimeClosed: {
    color: "#57534e",
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 8,
  },
  hintReady: {
    color: "#34d399",
    fontSize: 12,
    fontWeight: "600",
  },
  hintDelivered: {
    color: "#78716c",
    fontSize: 12,
  },
  fab: {
    position: "absolute",
    right: 18,
    bottom: 24,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#f59e0b",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});