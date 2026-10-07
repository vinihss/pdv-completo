import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 24,
    paddingHorizontal: 16,
    backgroundColor: "#1c1917",
    borderRadius: 16,
  },
  text: {
    color: "#fafaf9",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  subtext: {
    color: "#a8a29e",
    fontSize: 14,
    textAlign: "center",
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(251,191,36,0.12)",
  },
  inlineText: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "600",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(248,113,113,0.16)",
  },
  bannerText: {
    color: "#fecaca",
    fontSize: 13,
    fontWeight: "600",
  },
  subtle: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 6,
  },
  subtleText: {
    color: "#a8a29e",
    fontSize: 13,
  },
});

export function CourierSkeleton() {
  return (
    <View style={styles.container}>
      <ActivityIndicator color="#fbbf24" />
      <Text style={styles.text}>Carregando entregas…</Text>
    </View>
  );
}

export function CourierError({ message }) {
  return (
    <View style={styles.container}>
      <Ionicons name="warning" size={22} color="#f59e0b" />
      <Text style={styles.text}>Não foi possível carregar suas entregas</Text>
      {message ? <Text style={styles.subtext}>{message}</Text> : null}
    </View>
  );
}

export function CourierEmpty() {
  return (
    <View style={styles.subtle}>
      <Ionicons name="bicycle" size={20} color="#a8a29e" />
      <Text style={styles.subtleText}>Sem entregas atribuídas no momento</Text>
    </View>
  );
}

export function QueueEmpty() {
  return (
    <View style={styles.subtle}>
      <Ionicons name="list" size={20} color="#a8a29e" />
      <Text style={styles.subtleText}>Nenhuma entrega na fila</Text>
    </View>
  );
}

export function OfflineBanner() {
  return (
    <View style={styles.banner}>
      <Ionicons name="cloud-offline" size={16} color="#fecaca" />
      <Text style={styles.bannerText}>Você está offline. Algumas ações podem falhar.</Text>
    </View>
  );
}

export function StaleWarning() {
  return (
    <View style={styles.inline}>
      <Ionicons name="refresh" size={16} color="#fbbf24" />
      <Text style={styles.inlineText}>Dados podem estar desatualizados</Text>
    </View>
  );
}
