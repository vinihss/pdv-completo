import React, { useState } from "react";
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
 * logado no menu — mas é bobo de propósito: só conhece `name` e `photoPath`,
 * nada de papel, PIN ou vocabulário de domínio.
 *
 * `className` é o que o caller controla de específico (tamanho, espaçamento);
 * o formato do círculo e a cor das iniciais são da casa, para as duas telas
 * não divergirem. Foto quebrada (arquivo removido, linha antiga apontando
 * para caminho morto) cai para as iniciais em vez de virar ícone de imagem
 * arrebentada.
 *
 * O `block` do `<img>` não é decoração: `mx-auto` do caller só centraliza
 * elemento de nível block, e imagem é inline por padrão — sem isso o avatar
 * da tela de PIN grudaria na esquerda.
 */
export default function UserAvatar({ name, photoPath, className = "" }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const showPhoto = Boolean(photoPath) && failedSrc !== photoPath;

  if (showPhoto) {
    return (
      <img
        src={assetUrl(photoPath)}
        alt={name}
        onError={() => setFailedSrc(photoPath)}
        className={`block rounded-full object-cover shrink-0 bg-stone-800 ${className}`}
      />
    );
  }

  return (
    <div
      className={`rounded-full bg-stone-800 shrink-0 flex items-center justify-center font-display font-bold text-amber-400 ${className}`}
    >
      {initialsOf(name)}
    </div>
  );
}
