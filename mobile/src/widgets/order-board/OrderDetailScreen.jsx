// Detalhe da comanda — porta RN do OrderDetailScreen web. A comanda vem do
// OrderFlowContext (a mesma lista realtime do board); qualquer mutação
// recarrega ao ganhar foco. Rodapé fixo: adicionar item + fechar conta.
import { useCallback, useLayoutEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/app/providers/auth";
import {
  closeOrder,
  deleteItem,
  orderLabel,
  orderTotal,
  pendingItems,
  updateItemStatus,
  variationsText,
} from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import { isDaemonConfigured } from "@/shared/lib/server";
import { printOrder } from "@/features/orders/lib/printer.js";
import ConfirmModal from "@/features/orders/ui/ConfirmModal.jsx";
import PrintLayoutModal from "@/features/orders/ui/PrintLayoutModal.jsx";
import { useAlertsBoxContext } from "./AlertsBoxProvider.jsx";
import { closeFailure, closePlan } from "./closeAction.js";
import { useOrderFlow } from "./OrderFlowProvider.jsx";
import { useToast } from "./Toast.jsx";
import StatusBadge from "./ui/StatusBadge.jsx";

const METHOD_LABEL = { cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" };

export default function OrderDetailScreen({ route, navigation }) {
  const orderId = route.params?.orderId;
  const { storeSettings } = useAuth();
  const { orders, reloadOne } = useOrderFlow();
  const { markRead } = useAlertsBoxContext();
  const { showToast } = useToast();

  const order = orders.find((o) => o.id === orderId) ?? null;

  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyItemId, setBusyItemId] = useState(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const printerEnabled = (storeSettings?.printerEnabled ?? false) && isDaemonConfigured();

  // A comanda é a mesma lista do board (realtime); voltar de add-item/pagamento
  // (ou receber um evento enquanto aberta) recarrega a partir do backend.
  // A mesma focagem desconta o alerta desta comanda: a tela foi vista, então o
  // sino não pode seguir apitando por ela (porta do markRead(openOrderRecord)
  // do web — no backend, `mark-read` com orderId desmarca na fonte).
  useFocusEffect(
    useCallback(() => {
      if (!orderId) return;
      reloadOne(orderId);
      markRead(orderId);
    }, [orderId, reloadOne, markRead])
  );

  useLayoutEffect(() => {
    if (!order) return;
    navigation.setOptions({
      title: orderLabel(order),
      headerRight: printerEnabled
        ? () => (
            <Pressable onPress={() => setPrintOpen(true)} hitSlop={8} accessibilityLabel="Imprimir pedido">
              <Ionicons name="print-outline" size={20} color="#a8a29e" />
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, order, printerEnabled]);

  if (!order) {
    return (
      <View style={styles.screen}>
        <Text style={styles.emptyText}>Comanda não encontrada.</Text>
      </View>
    );
  }

  const pending = pendingItems(order);
  const canClose = pending.length === 0;
  const payments = order.payments ?? [];
  const hasPayments = payments.length > 0;

  async function handlePrint(destination) {
    setPrinting(true);
    try {
      await printOrder(order, destination);
      showToast(`Pedido enviado para impressão (${destination === "kitchen" ? "cozinha" : "entrega"}).`, "success");
      setPrintOpen(false);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPrinting(false);
    }
  }

  async function handleItemTap(item) {
    if (item.status === "delivered" || item.status === "cancelled") return;
    const isDeliverable = kitchenEnabled ? item.status === "ready" : item.status === "ordered";
    if (!isDeliverable) return;
    setBusyItemId(item.id);
    try {
      await updateItemStatus(order.id, item.id, "delivered", item.version);
      await reloadOne(order.id);
    } catch (e) {
      if (e.code === "concurrency_conflict") {
        showToast("Este item foi alterado por outra pessoa. Lista atualizada.", "error");
        await reloadOne(order.id);
      } else {
        showToast(e.message, "error");
      }
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleDeleteConfirmed(item) {
    setConfirmDelete(null);
    try {
      await deleteItem(order.id, item.id);
      await reloadOne(order.id);
    } catch (e) {
      showToast(e.message, "error");
      // 409 item_already_delivered: outra sessão mexeu primeiro — recarrega
      // para a tela parar de mostrar o item como removível (AC §4).
      await reloadOne(order.id);
    }
  }

  function openPayment() {
    setCloseError(null);
    navigation.navigate("Payment", {
      orderId,
      enabledMethods: storeSettings?.enabledPaymentMethods ?? ["cash", "card", "pix", "other"],
      storeSettings,
    });
  }

  async function handleClose() {
    setCloseError(null);
    // O que o botão faz (bloquear / ir para pagamento / fechar) e como a falha
    // do backend é traduzida moram em closeAction.js, testados sem render.
    const plan = closePlan({ pendingCount: pending.length, hasPayments });
    if (plan === "blocked") return;
    if (plan === "payment") {
      openPayment();
      return;
    }
    setClosing(true);
    try {
      await closeOrder(order.id);
      showToast("Comanda fechada.", "success");
      navigation.goBack();
    } catch (e) {
      const failure = closeFailure(e);
      if (failure.kind === "pending") setCloseError(failure.message);
      else if (failure.kind === "payment") openPayment();
      else showToast(failure.message, "error");
    } finally {
      setClosing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={order.items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.subHeader}>
              <Text style={styles.subHeaderCount}>
                {order.items.length} {order.items.length === 1 ? "item" : "itens"} · {formatBRL(orderTotal(order))}
              </Text>
            </View>

            {order.delivery?.address ? (
              <View style={styles.addressBox}>
                <Text style={styles.boxTitle}>Endereço de entrega</Text>
                <Text style={styles.boxText}>
                  <Ionicons name="location-outline" size={13} color="#fbbf24" /> {order.delivery.address}
                </Text>
              </View>
            ) : null}

            {order.notes ? (
              <View style={styles.notesBox}>
                <Text style={styles.boxTitle}>Observação do cliente</Text>
                <Text style={styles.boxText}>{order.notes}</Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={<Text style={styles.emptyItems}>Nenhum item lançado ainda.</Text>}
        renderItem={({ item: it }) => {
          const isDeliverable = kitchenEnabled ? it.status === "ready" : it.status === "ordered";
          const canDelete = kitchenEnabled ? it.status !== "delivered" : true;
          const variations = variationsText(it.selectedVariations);
          return (
            <Pressable
              onPress={() => handleItemTap(it)}
              disabled={!isDeliverable && !canDelete}
              style={[styles.item, isDeliverable && styles.itemDeliverable, kitchenEnabled && it.status === "delivered" && styles.itemDelivered]}
            >
              <View style={styles.itemBody}>
                <Text style={styles.itemName}>
                  {it.quantity}× {it.name}
                </Text>
                {variations ? <Text style={styles.itemMeta}>{variations}</Text> : null}
                {it.notes ? <Text style={styles.itemNote}>{it.notes}</Text> : null}
              </View>
              <Text style={styles.itemPrice}>{formatBRL(it.unitPrice * it.quantity)}</Text>
              <View style={styles.itemActions}>
                {kitchenEnabled && <StatusBadge status={it.status} />}
                {canDelete && (
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(it);
                    }}
                    hitSlop={6}
                    accessibilityLabel={`Remover ${it.name} da comanda`}
                  >
                    <Ionicons name="trash-outline" size={15} color="#78716c" />
                  </Pressable>
                )}
                {busyItemId === it.id && <Ionicons name="time-outline" size={14} color="#78716c" />}
              </View>
            </Pressable>
          );
        }}
      />

      {!kitchenEnabled && order.items.some((i) => i.status === "ordered") && (
        <View style={styles.noKitchenBox}>
          <Text style={styles.noKitchenText}>
            Sem cozinha cadastrada — toque no item para marcar como entregue.
          </Text>
        </View>
      )}

      {closeError && (
        <View style={styles.closeErrorBox}>
          <Ionicons name="alert-circle" size={14} color="#fbbf24" />
          <Text style={styles.closeErrorText}>{closeError}</Text>
        </View>
      )}

      {hasPayments && (
        <View style={styles.paymentsBox}>
          <Pressable style={styles.paymentRegistered} onPress={openPayment} accessibilityRole="button">
            <Ionicons name="checkmark-circle" size={16} color="#34d399" />
            <Text style={styles.paymentRegisteredLabel}>Pagamento registrado</Text>
            <Text style={styles.paymentAdjust}>Ajustar</Text>
          </Pressable>
          {payments.map((p) => {
            const label = METHOD_LABEL[p.method] ?? p.method;
            return (
              <View key={p.id} style={styles.paymentRow}>
                <Text style={styles.paymentRowLabel}>
                  {label}
                  {!p.confirmed && <Text style={styles.paymentPending}> aguardando confirmação</Text>}
                </Text>
                <View style={styles.paymentRowRight}>
                  <Text style={styles.paymentRowAmount}>{formatBRL(p.amount)}</Text>
                  {p.change > 0 && <Text style={styles.paymentRowChange}>troco {formatBRL(p.change)}</Text>}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {!canClose && (
        <View style={styles.pendingBox}>
          <Ionicons name="hourglass-outline" size={14} color="#fbbf24" />
          <Text style={styles.pendingText}>
            Aguardando entrega: {pending.map((it) => `${it.quantity}× ${it.name}`).join(", ")}
          </Text>
        </View>
      )}

      <View style={styles.footer}>
        <Pressable onPress={() => navigation.navigate("AddItem", { orderId })} style={styles.addButton} accessibilityRole="button">
          <Ionicons name="add" size={18} color="#fafaf9" />
          <Text style={styles.addLabel}>Adicionar item</Text>
        </Pressable>
        {!canClose ? (
          <View style={styles.closeDisabled}>
            <Text style={styles.closeDisabledLabel}>
              Fechar conta ({pending.length} pendente{pending.length > 1 ? "s" : ""})
            </Text>
          </View>
        ) : (
          <Pressable onPress={handleClose} disabled={closing} style={[styles.closeAble, closing && styles.methodDisabled]}>
            <Text style={styles.closeAbleLabel}>
              {closing ? "Fechando…" : hasPayments ? "Fechar conta" : "Registrar pagamento e fechar"}
            </Text>
          </Pressable>
        )}
      </View>

      {confirmDelete && (
        <ConfirmModal
          title="Remover item?"
          message={`${confirmDelete.quantity}× ${confirmDelete.name} será removido da comanda. Essa ação não pode ser desfeita.`}
          confirmLabel="Remover"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDeleteConfirmed(confirmDelete)}
        />
      )}
      {printOpen && <PrintLayoutModal onClose={() => setPrintOpen(false)} onPrint={handlePrint} busy={printing} />}
    </View>
  );
}

const styles = StyleSheet.create({
  methodDisabled: {
    opacity: 0.5,
  },
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  emptyText: {
    color: "#78716c",
    textAlign: "center",
    paddingTop: 48,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 180,
  },
  subHeader: {
    paddingTop: 12,
    paddingBottom: 10,
  },
  subHeaderCount: {
    color: "#a8a29e",
    fontSize: 15,
    fontWeight: "700",
  },
  addressBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    backgroundColor: "rgba(245,158,11,0.05)",
    padding: 12,
    marginBottom: 10,
  },
  notesBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#1c1917",
    padding: 12,
    marginBottom: 10,
  },
  boxTitle: {
    color: "#fbbf24",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  boxText: {
    color: "#fafaf9",
    fontSize: 14,
    lineHeight: 18,
  },
  emptyItems: {
    color: "#57534e",
    textAlign: "center",
    paddingVertical: 40,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1c1917",
  },
  itemDeliverable: {
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.4)",
    borderRadius: 12,
    borderBottomWidth: 1,
    paddingHorizontal: 10,
    marginHorizontal: -10,
  },
  itemDelivered: {
    opacity: 0.5,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
  },
  itemName: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "600",
  },
  itemMeta: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 1,
  },
  itemNote: {
    color: "#57534e",
    fontSize: 12,
    fontStyle: "italic",
    marginTop: 1,
  },
  itemPrice: {
    color: "#a8a29e",
    fontSize: 14,
  },
  itemActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  noKitchenBox: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  noKitchenText: {
    color: "#78716c",
    fontSize: 12,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 12,
    padding: 10,
  },
  closeErrorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: "rgba(245,158,11,0.1)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    borderRadius: 12,
    padding: 10,
  },
  pendingBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    padding: 10,
  },
  pendingText: {
    flex: 1,
    color: "#a8a29e",
    fontSize: 12,
    lineHeight: 16,
  },
  closeErrorText: {
    flex: 1,
    color: "#fbbf24",
    fontSize: 12,
    lineHeight: 16,
  },
  paymentsBox: {
    marginHorizontal: 16,
    gap: 6,
    marginBottom: 8,
  },
  paymentRegistered: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(16,185,129,0.1)",
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.3)",
    borderRadius: 12,
    padding: 10,
  },
  paymentRegisteredLabel: {
    flex: 1,
    color: "#34d399",
    fontSize: 13,
    fontWeight: "700",
  },
  paymentAdjust: {
    color: "#fafaf9",
    fontSize: 12,
    textDecorationLine: "underline",
  },
  paymentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  paymentRowLabel: {
    color: "#a8a29e",
    fontSize: 12,
  },
  paymentPending: {
    color: "#fbbf24",
  },
  paymentRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  paymentRowAmount: {
    color: "#e7e5e4",
    fontSize: 13,
    fontWeight: "700",
  },
  paymentRowChange: {
    color: "#34d399",
    fontSize: 12,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    backgroundColor: "#1c1917",
  },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 14,
    paddingVertical: 13,
  },
  addLabel: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "700",
  },
  closeDisabled: {
    backgroundColor: "#292524",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  closeDisabledLabel: {
    color: "#57534e",
    fontSize: 15,
    fontWeight: "700",
  },
  closeAble: {
    backgroundColor: "#10b981",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  closeAbleLabel: {
    color: "#022c22",
    fontSize: 15,
    fontWeight: "700",
  },
});