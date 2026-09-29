import React from "react";
import { formatBRL } from "@/shared/lib";
import { productQty } from "@/entities/cart";
import { assetUrl } from "@/shared/lib/server";

// Card dos Destaques (vitrine): 3 colunas, foto quadrada e abaixo o preço e o
// título — na ordem que o cliente lê. Não há botão de "+": o clique abre a
// ficha completa do produto (foto grande, variações, quantidade) antes de
// qualquer coisa entrar no carrinho. Variações não são listadas aqui (não cabem
// em ~120px de largura): quem marcar o produto vê as escolhas na ficha.
export default function ProductTile({ product, cart, onOpen }) {
  const qty = productQty(cart, product.id);
  const hasOptions = (product.variations?.length ?? 0) > 0;

  return (
    <button onClick={() => onOpen(product)} className="flex flex-col text-left" aria-label={`Ver ${product.name}`}>
      <div className="relative aspect-square rounded-xl overflow-hidden bg-stone-800">
        {product.imagePath ? (
          <img src={assetUrl(product.imagePath)} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-600 font-display text-2xl font-bold">
            {(product.name?.[0] ?? "?").toUpperCase()}
          </div>
        )}
        {qty > 0 && (
          <span className="absolute top-2 left-2 bg-amber-500 text-[var(--brand-accent-foreground)] text-[11px] font-bold rounded-full px-2 py-0.5">
            {qty} no carrinho
          </span>
        )}
      </div>
      <p className="mt-2 text-[13px] font-semibold text-amber-400 leading-tight">{formatBRL(product.price)}</p>
      <p className="text-[12.5px] text-stone-100 leading-snug line-clamp-2">{product.name}</p>
      {hasOptions && <p className="text-[10.5px] text-stone-500 mt-0.5">opções</p>}
    </button>
  );
}
