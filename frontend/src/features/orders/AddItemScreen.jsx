import React, { useState, useEffect } from "react";
import { Search, Check, AlertTriangle } from "lucide-react";
import { ScreenHeader } from "@/shared/components";
import { listCategories } from "@/entities/category";
import { listAllProducts } from "@/entities/product";
import { addItems as addOrderItems } from "@/entities/order";
import { useAuth } from "@/app/providers/auth";
import { formatBRL } from "@/shared/lib";
import { VariationModal } from "@/entities/product";
import ReviewCartModal from "./ReviewCartModal.jsx";
import { assetUrl } from "@/shared/lib/server";

export default function AddItemScreen({ order, onClose, onConfirmed, showToast }) {
  const { storeSettings } = useAuth();
  const stockEnabled = storeSettings?.inventoryEnabled ?? false;
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState({}); // productId -> { product, quantity, selectedVariations, notes }
  const [variationModal, setVariationModal] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    listCategories().then(setCategories).catch(() => {});
    listAllProducts({ active: "true" }).then(({ data }) => setProducts(data)).catch(() => {});
  }, []);

  const filteredProducts = products.filter((p) => {
    if (activeCategory && p.categoryId !== activeCategory) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  function addToCart(product, selectedVariations = {}) {
    setCart((prev) => {
      const key = product.id + JSON.stringify(selectedVariations);
      const existing = prev[key];
      return { ...prev, [key]: { product, quantity: (existing?.quantity ?? 0) + 1, selectedVariations, notes: existing?.notes ?? "" } };
    });
  }

  function changeNotes(key, notes) {
    setCart((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: { ...existing, notes } };
    });
  }

  function handleProductTap(product) {
    if (product.variations?.length > 0) {
      setVariationModal(product);
    } else {
      addToCart(product);
    }
  }

  function cartQtyForProduct(productId) {
    return Object.values(cart)
      .filter((c) => c.product.id === productId)
      .reduce((sum, c) => sum + c.quantity, 0);
  }

  const cartLines = Object.values(cart);
  const cartCount = cartLines.reduce((sum, c) => sum + c.quantity, 0);
  const cartTotal = cartLines.reduce((sum, c) => sum + c.product.price * c.quantity, 0);

  async function handleConfirmBatch() {
    setConfirming(true);
    try {
      const items = cartLines.map((c) => ({
        productId: c.product.id,
        quantity: c.quantity,
        selectedVariations: c.selectedVariations,
        notes: c.notes?.trim() || undefined,
      }));
      await addOrderItems(order.id, items);
      setTimeout(async () => {
        setConfirming(false);
        await onConfirmed();
      }, 700);
    } catch (e) {
      setConfirming(false);
      showToast(e.message, "error");
    }
  }

  return (
    <div className="fixed inset-0 bg-stone-950 text-stone-50 z-40 flex flex-col">
      <ScreenHeader title="Adicionar item" onBack={onClose} backLabel="Fechar lançamento" backIcon="close" />

      <div className="px-5 pt-4 shrink-0">
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar produto..."
            className="w-full bg-stone-900 border border-stone-800 rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-amber-500/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveCategory(null)}
            className={`shrink-0 px-3 py-1.5 text-xs font-semibold border-b-2 ${!activeCategory ? "text-amber-500 border-amber-500" : "text-stone-400 border-transparent"}`}
          >
            Todos
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`shrink-0 px-3 py-1.5 text-xs font-semibold border-b-2 ${activeCategory === c.id ? "text-amber-500 border-amber-500" : "text-stone-400 border-transparent"}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto px-5 pt-4 ${cartCount > 0 ? "pb-24" : "pb-6"}`}>
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filteredProducts.map((p) => {
            const addedQty = cartQtyForProduct(p.id);
            // Com estoque habilitado e produto rastreado, saldo zero bloqueia
            // a inclusão (o backend também valida no confirmar).
            const outOfStock = stockEnabled && p.trackStock && p.quantity <= 0;
            return (
              <button
                key={p.id}
                onClick={() => !outOfStock && handleProductTap(p)}
                disabled={outOfStock}
                className={`relative overflow-hidden text-left rounded-2xl p-4 border transition-all active:scale-95 ${
                  outOfStock
                    ? "bg-stone-900 border-stone-800 opacity-50"
                    : addedQty > 0
                      ? "bg-emerald-500/10 border-emerald-500/50"
                      : "bg-stone-800 border-stone-700 hover:bg-stone-750"
                }`}
              >
                {addedQty > 0 && !outOfStock && (
                  <span className="absolute top-2 right-2 bg-emerald-500 text-emerald-950 text-xs font-bold min-w-[1.5rem] h-6 px-1 rounded-full flex items-center justify-center shadow-lg pop-anim">
                    {addedQty}
                  </span>
                )}
                {p.imagePath && (
                  <img src={assetUrl(p.imagePath)} alt={p.name} className="w-full h-24 object-cover rounded-xl -mt-1 mb-2" />
                )}
                <div className="font-semibold text-sm mb-1 pr-6">{p.name}</div>
                <div className="text-emerald-400 text-sm font-bold">{formatBRL(p.price)}</div>
                {p.description && <div className="text-stone-500 text-xs mt-1 line-clamp-2">{p.description}</div>}
                {p.variations?.length > 0 && <div className="text-stone-500 text-xs mt-1">Opções disponíveis</div>}
                {outOfStock && (
                  <div className="flex items-center gap-1 text-red-400 text-xs font-bold mt-1">
                    <AlertTriangle size={12} /> Sem estoque
                  </div>
                )}
              </button>
            );
          })}
          {filteredProducts.length === 0 && (
            <div className="col-span-2 text-stone-600 text-center py-12 text-sm">Nenhum produto encontrado.</div>
          )}
        </div>
      </div>

      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-stone-800 bg-stone-900 z-30">
          <button
            onClick={() => setReviewOpen(true)}
            className="w-full flex items-center justify-between bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold py-3.5 px-5 rounded-xl transition-colors"
          >
            <span className="flex items-center gap-2">
              <Check size={18} strokeWidth={2.5} />
              {cartCount} {cartCount === 1 ? "item" : "itens"} · {formatBRL(cartTotal)}
            </span>
            <span className="text-sm">Revisar e confirmar →</span>
          </button>
        </div>
      )}

      {variationModal && (
        <VariationModal
          product={variationModal}
          onClose={() => setVariationModal(null)}
          onConfirm={(selection) => {
            addToCart(variationModal, selection);
            setVariationModal(null);
          }}
        />
      )}

      {reviewOpen && (
        <ReviewCartModal
          lines={cartLines}
          total={cartTotal}
          onClose={() => setReviewOpen(false)}
          onRemoveLine={(key) => setCart((prev) => { const next = { ...prev }; delete next[key]; return next; })}
          onChangeNotes={changeNotes}
          onConfirm={handleConfirmBatch}
        />
      )}

      {confirming && (
        <div className="fixed inset-0 bg-stone-900/97 flex flex-col items-center justify-center z-50 pop-anim">
          <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-4">
            <Check size={28} className="text-emerald-400" />
          </div>
          <div className="font-display text-lg font-bold">Itens adicionados!</div>
        </div>
      )}
    </div>
  );
}