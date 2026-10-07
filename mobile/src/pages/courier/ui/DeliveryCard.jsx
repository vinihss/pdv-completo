import React from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { maskPhone } from "@/shared/lib/format";
import { elapsedInfo } from "../model/elapsed";
import {
  addressText,
  customerName,
  customerPhone,
  estimatedText,
  orderLines,
  shortOrderId,
} from "../model/orderView";
import { mapsUrl } from "../model/mapsLink";

const PRIMARY_MIN_HEIGHT = 56;

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(120,113,108,0.4)",
    padding: 16,
    gap: 12,
  },
  hero: {
    borderColor: "rgba(251,191,36,0.6)",
    shadowColor: "rgba(251,191,36,0.25)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  titleBlock: {
    flex: 1,
    gap: 4,
  },
  title: {
    color: "#fafaf9",
    fontSize: 18,
    fontWeight: "700",
  },
  meta: {
    color: "#a8a29e",
    fontSize: 13,
  },
  elapsed: {
    color: "#d6d3d1",
    fontSize: 13,
    fontWeight: "600",
  },
  elapsedUrgent: {
    color: "#fca5a5",
  },
  phone: {
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  phoneText: {
    color: "#a8a29e",
    fontSize: 13,
    textDecorationLine: "underline",
  },
  estimated: {
    color: "#a8a29e",
    fontSize: 13,
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    color: "#d6d3d1",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  lines: {
    gap: 4,
  },
  lineText: {
    color: "#e7e5e4",
    fontSize: 14,
  },
  address: {
    color: "#e7e5e4",
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(120,113,108,0.28)",
    minHeight: 44,
  },
  actionPrimary: {
    backgroundColor: "#fbbf24",
    minHeight: PRIMARY_MIN_HEIGHT,
    // Cresce para ocupar a linha inteira quando é o único, mas não empurra a
    // Rota para fora: `flexGrow` só distribui o sobra (RN já nasce com
    // `flexShrink: 0`, então o rótulo nunca esmaga).
    flexGrow: 1,
  },
  actionGhost: {
    backgroundColor: "rgba(120,113,108,0.22)",
  },
  actionDangerGhost: {
    backgroundColor: "rgba(239,68,68,0.18)",
  },
  actionText: {
    color: "#e7e5e4",
    fontSize: 14,
    fontWeight: "600",
  },
  actionPrimaryText: {
    color: "#1c1917",
    fontSize: 16,
    fontWeight: "700",
  },
  actionGhostText: {
    color: "#d6d3d1",
    fontSize: 14,
    fontWeight: "600",
  },
  actionDangerText: {
    color: "#fecaca",
    fontSize: 14,
    fontWeight: "600",
  },
});

/**
 * Card de entrega do entregador.
 *
 * Regra de produto (`docs/04-delivery-self-service-integration.md` §
 * Superfícies de UI): **no máximo 2 ações visíveis por entrega**. Aqui ela é
 * por construção, não por `slice`: a linha de ação recebe só o botão que muda o
 * estado (Saí para entrega / Entreguei) e a Rota — que é link de DADO, não
 * muda o pedido, e some sozinha quando não há endereço. Nunca dá 3.
 *
 * O registrar problema é o caminho de EXCEÇÃO: fica numa faixa própria,
 * abaixo da linha de ação, e só existe na entrega EM TRÂNSITO (a máquina de
 * status recusa `fail` a partir de `awaiting_courier` — mostrar o botão na
 * fila seria convite a 409). Como não mora dentro da linha, nunca é cortado
 * por ela: em rota ele está sempre à mão.
 *
 * A primária tem 56px de altura (alcance de polegar, uma mão, na rua). O
 * telefone é link de dado na linha de cabeçalho, como no web.
 *
 * Server-authoritative (o `await` + reload vive no `CourierApp`): o card só
 * chama os callbacks, não otimiza nada.
 */
export default function DeliveryCard({
  delivery,
  now,
  variant = "compact",
  busy = false,
  onDispatch,
  onDeliver,
  onFail,
}) {
  const name = customerName(delivery);
  const phone = customerPhone(delivery);
  const addr = addressText(delivery);
  const lines = orderLines(delivery);
  const est = estimatedText(delivery?.estimatedMinutes);
  const elapsed = elapsedInfo(delivery, now);
  const orderRef = shortOrderId(delivery?.orderId ?? delivery?.id);
  const mapLink = mapsUrl(addr);

  const isHero = variant === "hero";
  const isQueue = delivery?.status === "awaiting_courier";
  const isActive = delivery?.status === "out_for_delivery";

  const handleCall = async () => {
    if (!phone) return;
    try {
      await Linking.openURL(`tel:${phone}`);
    } catch {
      // ignore
    }
  };

  const handleMaps = async () => {
    if (!mapLink) return;
    try {
      await Linking.openURL(mapLink);
    } catch {
      // ignore
    }
  };

  const actions = [];
  if (isQueue) {
    actions.push({
      key: "dispatch",
      label: "Saí para entrega",
      primary: true,
      onPress: onDispatch,
    });
  }
  if (isActive) {
    actions.push({
      key: "deliver",
      label: "Entreguei",
      primary: true,
      onPress: onDeliver,
    });
  }
  if (mapLink) {
    actions.push({ key: "route", label: "Rota", onPress: handleMaps, ghost: true });
  }

  return (
    <View style={[styles.card, isHero && styles.hero]}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{name}</Text>
          {orderRef ? <Text style={styles.meta}>{orderRef}</Text> : null}
          {elapsed ? (
            <Text style={[styles.elapsed, elapsed.urgent && styles.elapsedUrgent]}>
              {elapsed.text}
            </Text>
          ) : null}
          {phone ? (
            <TouchableOpacity
              style={styles.phone}
              onPress={handleCall}
              accessibilityRole="link"
              accessibilityLabel={`Ligar para ${name}`}
              testID="delivery-call"
            >
              <Text style={styles.phoneText}>{maskPhone(phone)}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {est ? <Text style={styles.estimated}>{est}</Text> : null}

      {lines.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Itens</Text>
          <View style={styles.lines}>
            {lines.map((line, idx) => (
              <Text key={idx} style={styles.lineText}>
                • {line}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      {addr ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Endereço</Text>
          <Text style={styles.address}>{addr}</Text>
        </View>
      ) : null}

      <View style={styles.actions} testID="delivery-actions">
        {actions.map((action) => {
          const isPrimary = action.primary;
          return (
            <TouchableOpacity
              key={action.key}
              onPress={action.onPress}
              disabled={busy}
              testID={`delivery-action-${action.key}`}
              style={[
                styles.actionButton,
                isPrimary && styles.actionPrimary,
                !isPrimary && action.ghost && styles.actionGhost,
              ]}
            >
              <Text style={[styles.actionText, isPrimary && styles.actionPrimaryText, !isPrimary && styles.actionGhostText]}>
                {action.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Faixa de exceção: fora da linha de ação de propósito — em rota ela
          nunca pode ser cortada, e fora dela não existe. */}
      {isActive ? (
        <TouchableOpacity
          onPress={onFail}
          disabled={busy}
          testID="delivery-action-fail"
          style={[styles.actionButton, styles.actionDangerGhost]}
        >
          <Text style={[styles.actionText, styles.actionDangerText]}>Problema na entrega</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
