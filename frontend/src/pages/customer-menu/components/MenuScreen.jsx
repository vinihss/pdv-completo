import React from "react";
import { Search, X, ShoppingBag } from "lucide-react";
import { formatBRL } from "@/shared/lib";
import ProductCard from "./ProductCard.jsx";
import ProductTile from "./ProductTile.jsx";
import { assetUrl } from "@/shared/lib/server";

// ---------------------------------------------------------------------------
// Cardápio da página pública, no layout de loja do iFood:
//
//  1. header com o logo no meio — some ao rolar;
//  2. barra de busca + pills de categoria — escondida no topo, revelada ao
//     rolar (vem de showBar, que o page calcula com o scroll);
//  3. Destaques (product.featured) em 3 colunas, foto/preço/título;
//  4. uma seção por categoria, um produto abaixo do outro com a foto à
//     direita (2 col no lg, 3 no xl, pra não esticar a linha).
//
// As pills não filtram: elas rolam até a seção (data-section). Só a busca
// filtra, e quando há texto a página vira uma lista plana de resultados.
// ---------------------------------------------------------------------------
export default function MenuScreen({
  menu,
  cart,
  viaWhatsApp,
  logoUrl,
  merchantName,
  searchTerm,
  onSearchChange,
  showBar,
  activeSection,
  onSelectSection,
  addToCart,
  addToCartLine,
  removeFromCartLine,
  editLine,
  itemCount,
  subtotal,
  onOpenCart,
  activeOrder,
  onOpenActiveOrder,
}) {
  const searching = searchTerm.trim().length > 0;
  const allProducts = (menu?.categories ?? []).flatMap((c) => c.products);
  const featured = allProducts.filter((p) => p.featured);

  const sections = [
    ...(featured.length > 0 ? [{ id: "destaques", name: "Destaques", products: featured }] : []),
    ...menu.categories.map((c) => ({ id: c.id, name: c.name, products: c.products })),
  ];
  const pills = sections.map((s) => ({ id: s.id, name: s.name }));

  const query = searchTerm.trim().toLowerCase();
  const results = searching
    ? allProducts.filter(
        (p) => p.name.toLowerCase().includes(query) || (p.description ?? "").toLowerCase().includes(query)
      )
    : [];

  const pill = (active) =>
    `shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
      active ? "bg-amber-500 text-[var(--brand-accent-foreground)]" : "bg-stone-900 text-stone-300 border border-stone-800"
    }`;

  return (
    <>
      {/* ---- topo: logo no meio, some ao rolar ---- */}
      <div className="px-5 pt-5 pb-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <span />
          {logoUrl ? (
            <img src={assetUrl(logoUrl)} alt="Logo do restaurante" className="h-14 w-14 rounded-full object-contain" />
          ) : (
            <div className="h-14 w-14 rounded-full bg-stone-800 flex items-center justify-center">
              <span className="font-display text-xl font-bold text-amber-400">{(merchantName?.[0] ?? "B").toUpperCase()}</span>
            </div>
          )}
          <div className="flex justify-end">
            {viaWhatsApp && <span className="text-[10.5px] font-semibold bg-[#25D366]/15 text-[#25D366] px-2 py-0.5 rounded-full">WhatsApp</span>}
          </div>
        </div>
        <div className="text-center mt-3">
          <h1 className="text-[17px] font-extrabold tracking-tight truncate">{merchantName || "Cardápio"}</h1>
          <p className="text-[11px] tracking-[0.18em] uppercase text-amber-400/80 font-semibold mt-0.5">Pedido para entrega</p>
        </div>

        {activeOrder && (
          <button onClick={onOpenActiveOrder} className="mt-4 w-full rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-center justify-between gap-3 text-left">
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-stone-50">Você tem um pedido em andamento</span>
              <span className="block text-[12px] text-stone-400 mt-0.5 truncate">
                {activeOrder.customerStage?.label} · {formatBRL(activeOrder.total)}
              </span>
            </span>
            <span className="text-[12.5px] font-semibold text-amber-400 shrink-0">Ver status</span>
          </button>
        )}
      </div>

      {/* ---- barra sticky: só aparece quando rola (ou quando busca) ---- */}
      <div
        className={`sticky top-0 z-30 bg-stone-950/95 backdrop-blur border-b border-stone-800 px-5 transition-all duration-200 ${
          showBar ? "max-h-40 opacity-100" : "max-h-0 opacity-0 pointer-events-none border-b-0 overflow-hidden"
        }`}
      >
        <div className="py-3 space-y-2.5">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-0.5 text-stone-500 pointer-events-none" />
            <input
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Buscar produto"
              aria-label="Buscar produto"
              className="w-full bg-stone-900 border border-stone-800 rounded-lg pl-9 pr-8 h-10 text-[14px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-500"
            />
            {searchTerm && (
              <button
                onClick={() => onSearchChange("")}
                className="absolute right-2.5 top-1/2 -translate-y-0.5 text-stone-500 hover:text-stone-300"
                aria-label="Limpar busca"
              >
                <X size={15} />
              </button>
            )}
          </div>
          {/* pills somem durante a busca: não há seção para pular */}
          {!searching && (
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {pills.map((p) => (
                <button key={p.id} onClick={() => onSelectSection(p.id)} className={pill(activeSection === p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---- corpo ---- */}
      <div className="px-5 pb-28">
        {searching ? (
          results.length === 0 ? (
            <p className="text-stone-500 text-sm text-center mt-10">Nenhum produto encontrado.</p>
          ) : (
            <div className="pt-2">
              <h2 className="text-[13px] font-bold uppercase tracking-wide text-stone-500">Resultados</h2>
              {results.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  cart={cart}
                  onOpen={addToCart}
                  onInc={(key) => addToCartLine(key)}
                  onDec={(key) => removeFromCartLine(key)}
                  onEditLine={editLine}
                />
              ))}
            </div>
          )
        ) : (
          sections.map((s) => (
            <section key={s.id} id={`sec-${s.id}`} data-section={s.id} className="scroll-mt-28 pt-4">
              <h2 className="text-[13px] font-bold uppercase tracking-wide text-stone-500 mb-1">{s.name}</h2>
              {s.id === "destaques" ? (
                <div className="grid grid-cols-3 xl:grid-cols-4 gap-3 pt-1">
                  {s.products.map((p) => (
<ProductTile
                  key={p.id}
                  product={p}
                  cart={cart}
                  onOpen={addToCart}
                />
                  ))}
                </div>
              ) : (
                <div className="md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-x-6">
                  {s.products.map((p) => (
<ProductCard
                  key={p.id}
                  product={p}
                  cart={cart}
                  onOpen={addToCart}
                  onInc={(key) => addToCartLine(key)}
                  onDec={(key) => removeFromCartLine(key)}
                  onEditLine={editLine}
                />
                  ))}
                </div>
              )}
            </section>
          ))
        )}
      </div>

      {/* ---- barra do carrinho: fixed (era absolute: ficava no fim da página).
           No desktop ela vira um cartão no canto inferior direito — com o
           painel da direita removido, é por aqui que o carrinho é aberto. ---- */}
      {itemCount > 0 && (
        <button
          onClick={onOpenCart}
          className="fixed bottom-4 inset-x-4 z-30 lg:inset-x-auto lg:right-8 lg:w-80 bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl py-3.5 px-4 flex items-center justify-between gap-3 font-semibold shadow-lg shadow-black/30"
        >
          <span className="flex items-center gap-2 text-[14px]">
            <ShoppingBag size={17} />
            Ver carrinho · {itemCount} {itemCount === 1 ? "item" : "itens"}
          </span>
          <span className="text-[14px]">{formatBRL(subtotal)}</span>
        </button>
      )}
    </>
  );
}
