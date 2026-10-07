import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { customerName, shortOrderId } from "../model/orderView";

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(239,68,68,0.14)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.5)",
    padding: 14,
    gap: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    color: "#fee2e2",
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: "#fecaca",
    fontSize: 13,
  },
  reason: {
    color: "#fecaca",
    fontSize: 13,
    lineHeight: 18,
  },
});

export default function FailedDeliveryCard({ delivery }) {
  const orderRef = shortOrderId(delivery?.orderId ?? delivery?.id);
  // O motivo da falha é `notes`, não `failReason`: o `PATCH .../fail` grava
  // `{ status: "failed", notes: reason }` e é o único writer do campo (ver
  // docs/05-delivery-api-contracts.md). `failReason` nunca existiu no payload —
  // o card vinha desenhando "Motivo:" nunca.
  const reason = delivery?.notes || delivery?.failReason;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="alert-circle" size={18} color="#fecaca" />
        <Text style={styles.title}>{customerName(delivery)}</Text>
      </View>
      {orderRef ? <Text style={styles.meta}>{orderRef}</Text> : null}
      {reason ? <Text style={styles.reason}>Motivo: {reason}</Text> : null}
    </View>
  );
}
