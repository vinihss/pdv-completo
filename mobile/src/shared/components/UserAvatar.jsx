// Portado de frontend/src/shared/components/UserAvatar.jsx (adaptação RN).
// Mesmo contrato: círculo com a foto quando existe, iniciais quando não.
// `size` substitui o `className` que o web usava para controlar tamanho.

import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { assetUrl } from "@/shared/lib/server";

function initialsOf(name) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/**
 * Avatar de pessoa: a foto quando existe, as iniciais do primeiro e do
 * segundo nome quando não. Vive em `shared` porque o mesmo círculo aparece na
 * tela de login (grade de usuários e tela do PIN) e na identidade de quem está
 * logado — mas é bobo de propósito: só conhece `name` e `photoPath`, nada de
 * papel, PIN ou vocabulário de domínio.
 *
 * Foto quebrada (arquivo removido, servidor fora do ar) cai para as iniciais
 * em vez de virar quadrado quebrado — mesmo comportamento do web.
 */
export default function UserAvatar({ name, photoPath, size = 56 }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const showPhoto = Boolean(photoPath) && failedSrc !== photoPath;

  if (showPhoto) {
    return (
      <Image
        source={{ uri: assetUrl(photoPath) }}
        onError={() => setFailedSrc(photoPath)}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        accessibilityLabel={name}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.34 }]}>{initialsOf(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: "#1c1917", // stone-900 (enquanto carrega)
  },
  fallback: {
    backgroundColor: "#1c1917",
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: "#fbbf24", // amber-400 (igual ao web)
    fontWeight: "700",
  },
});