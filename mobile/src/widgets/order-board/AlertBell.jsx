// Sino de alertas do garçom (porta do AlertBell + AlertList do web), aposentado
// no header do Board. Só foca a comanda quando faz sentido para o papel
// (canOpenAlert) — cozinha/caixa/entregador não têm a tela de comandas.
// A caixa vem do AlertsBoxProvider (mesma instância que a tela da comanda usa
// para descontar o alerta ao abrir) — sem o provider ele não sobrevive.
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/app/providers/auth";
import { alertAgeLabel, alertSubtitle, canOpenAlert, groupAlertsByDay } from "./alertModel.js";
import OverlayModal from "@/features/orders/ui/OverlayModal.jsx";
import { useAlertsBoxContext } from "./AlertsBoxProvider.jsx";
import { useOrderFlow } from "./OrderFlowProvider.jsx";

export function AlertBell({ onPrevent = null }) {
  const { session } = useAuth();
  const { focusOrder } = useOrderFlow();
  const box = useAlertsBoxContext();

  function handleSelect(alert) {
    box.openAlert(alert);
    if (canOpenAlert(alert, session?.user?.role)) {
      focusOrder(alert.orderId);
      box.close();
    }
  }

  const groups = groupAlertsByDay(box.alerts);

  return (
    <>
      <Pressable
        onPress={box.openPanel}
        hitSlop={8}
        accessibilityLabel={box.unreadCount > 0 ? `Alertas (${box.unreadCount} não lidos)` : "Alertas"}
        accessibilityRole="button"
        style={styles.bell}
      >
        <Ionicons name={box.unreadCount > 0 ? "notifications" : "notifications-outline"} size={20} color={box.unreadCount > 0 ? "#fbbf24" : "#d6d3d1"} />
        {box.unreadCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeLabel}>{box.unreadCount > 99 ? "99+" : box.unreadCount}</Text>
          </View>
        )}
      </Pressable>

      <OverlayModal
        title={`Alertas${box.unreadCount > 0 ? ` · ${box.unreadCount} não lidos` : ""}`}
        onClose={box.close}
        visible={box.open && !onPrevent}
      >
        <ScrollView style={styles.content} contentContainerStyle={styles.listContent}>
          {box.loading && box.alerts.length === 0 && <Text style={styles.empty}>Carregando…</Text>}
          {!box.loading && box.alerts.length === 0 && <Text style={styles.empty}>Nada por aqui ainda.</Text>}
          {groups.map((group) => (
            <View key={group.label}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {group.items.map((alert) => {
                const read = Boolean(alert.readAt);
                const subtitle = alertSubtitle(alert);
                return (
                  <Pressable
                    key={alert.id}
                    onPress={() => handleSelect(alert)}
                    style={styles.row}
                    accessibilityRole="button"
                  >
                    <View style={[styles.dot, read ? styles.dotRead : styles.dotUnread]} />
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowTitle, read && styles.rowTitleRead]}>{alert.title}</Text>
                      {subtitle && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
                      <Text style={styles.rowTime}>
                        {alertAgeLabel(alert.createdAt)}
                        {read && " · lida"}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
        <View style={styles.footer}>
          <View style={styles.soundRow}>
            <Ionicons name={box.soundEnabled ? "volume-high-outline" : "volume-mute-outline"} size={18} color="#a8a29e" />
            <Text style={styles.soundLabel}>{box.soundEnabled ? "Som ligado" : "Som desligado"}</Text>
            <Switch
              value={box.soundEnabled}
              onValueChange={box.toggleSound}
              trackColor={{ false: "#44403c", true: "#f59e0b" }}
              thumbColor="#fafaf9"
            />
          </View>
          <Text style={styles.soundHint}>
            O som toca de novo enquanto o alerta continuar não lido. A preferência vale neste aparelho.
          </Text>
        </View>
      </OverlayModal>
    </>
  );
}

const styles = StyleSheet.create({
  bell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#f59e0b",
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeLabel: {
    color: "#1c1917",
    fontSize: 11,
    fontWeight: "700",
  },
  content: {
    maxHeight: 360,
  },
  listContent: {
    paddingBottom: 8,
    gap: 4,
  },
  empty: {
    color: "#78716c",
    fontSize: 14,
    paddingVertical: 24,
    textAlign: "center",
  },
  groupLabel: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  dotUnread: {
    backgroundColor: "#f59e0b",
  },
  dotRead: {
    backgroundColor: "#57534e",
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "600",
  },
  rowTitleRead: {
    color: "#a8a29e",
    fontWeight: "400",
  },
  rowSubtitle: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 2,
  },
  rowTime: {
    color: "#57534e",
    fontSize: 11,
    marginTop: 4,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 12,
    gap: 8,
  },
  soundRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  soundLabel: {
    flex: 1,
    color: "#d6d3d1",
    fontSize: 14,
  },
  soundHint: {
    color: "#57534e",
    fontSize: 11,
    lineHeight: 15,
  },
});