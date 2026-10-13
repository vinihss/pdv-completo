import React, { useState, useEffect } from "react";
import { Search, Check, AlertTriangle } from "lucide-react";
import { ScreenHeader, ConfirmModal } from "@/shared/components";
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
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [recentlyAdded, setRecentlyAdded] = useState(null); // productId adicionado recentemente
  const [showExitConfirmation, setShowExitConfirmation] = useState(false);
  
  // Carregar produtos frequentes do localStorage (últimos 6 produtos adicionados)
  const [frequentProducts, setFrequentProducts] = useState([]);
  
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`frequent_products_${order.id}`);
      if (stored) {
        setFrequentProducts(JSON.parse(stored));
      }
    } catch {
      // Ignora erros de localStorage
    }
  }, [order.id]);

  async function loadCatalog() {
    setCatalogLoading(true);
    setCatalogError(false);
    try {
      const [cats, prods] = await Promise.all([
        listCategories(),
        listAllProducts({ active: "true" }),
      ]);
      setCategories(cats);
      setProducts(prods.data);
    } catch {
      // Sem estado de erro a falha parecia catálogo vazio ("Nenhum produto
      // encontrado."): o garçom não sabia se não havia produto ou se a rede caiu.
      setCatalogError(true);
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => {
    loadCatalog();
  }, []);

  const filteredProducts = products.filter((p) => {
    if (activeCategory && p.categoryId !== activeCategory) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  function addToCart(product, selectedVariations = {}) {
    // Feedback visual: destacar produto recém-adicionado
    setRecentlyAdded(product.id);
    
    setCart((prev) => {
      const key = product.id + JSON.stringify(selectedVariations);
      const existing = prev[key];
      const newCart = { ...prev, [key]: { product, quantity: (existing?.quantity ?? 0) + 1, selectedVariations, notes: existing?.notes ?? "" } };
      return newCart;
    });
    
    // Salvar produto como frequente
    try {
      const frequentKey = `frequent_products_${order.id}`;
      const current = JSON.parse(localStorage.getItem(frequentKey) || '[]');
      const productId = product.id;
      const updated = [productId, ...current.filter(id => id !== productId)].slice(0, 6);
      localStorage.setItem(frequentKey, JSON.stringify(updated));
      setFrequentProducts(updated);
    } catch {
      // Ignora erros de localStorage
    }
  }

  // Limpar destaque após 600ms
  useEffect(() => {
    if (recentlyAdded) {
      const timer = setTimeout(() => setRecentlyAdded(null), 600);
      return () => clearTimeout(timer);
    }
  }, [recentlyAdded]);

  function changeNotes(key, notes) {
    setCart((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: { ...existing, notes } };
    });
  }

  // Ajuste de quantidade no carrinho (`− / +`). Mínimo 1: remover é papel do
  // botão de lixeira, então decrementar abaixo de 1 seria destrutivo e silencioso.
  function changeQty(key, delta) {
    setCart((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      const quantity = Math.max(1, existing.quantity + delta);
      return { ...prev, [key]: { ...existing, quantity } };
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

  function handleExit() {
    if (cartCount > 0) {
      setShowExitConfirmation(true);
    } else {
      onClose();
    }
  }

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
        await onConfirmed(cartCount);
      }, 700);
    } catch (e) {
      setConfirming(false);
      showToast(e.message, "error");
    }
  }

  return (
    <div className="fixed inset-0 bg-background text-foreground z-40 flex flex-col">
      <ScreenHeader title="Adicionar item" onBack={handleExit} backLabel="Fechar lançamento" backIcon="close" />

      <div className="px-5 pt-4 shrink-0">
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar produto..."
            className="w-full bg-surface border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-ring/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveCategory(null)}
            className={`shrink-0 px-3 py-1.5 text-xs font-semibold border-b-2 ${!activeCategory ? "text-primary border-ring" : "text-text-secondary border-transparent"}`}
          >
            Todos
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`shrink-0 px-3 py-1.5 text-xs font-semibold border-b-2 ${activeCategory === c.id ? "text-primary border-ring" : "text-text-secondary border-transparent"}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto px-5 pt-4 ${cartCount > 0 ? "pb-24" : "pb-6"}`}>
        {/* Seção de Produtos Frequentes */}
        {frequentProducts.length > 0 && !search && !activeCategory && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-secondary">Frequentemente adicionados</h3>
              <button
                onClick={() => {
                  try {
                    localStorage.removeItem(`frequent_products_${order.id}`);
                    setFrequentProducts([]);
                  } catch {
                    // Ignora erros
                  }
                }}
                className="text-xs text-text-muted hover:text-text-secondary"
              >
                Limpar
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {frequentProducts.map((productId) => {
                const p = products.find(prod => prod.id === productId);
                if (!p) return null;
                
                const addedQty = cartQtyForProduct(p.id);
                const outOfStock = stockEnabled && p.trackStock && p.quantity <= 0;
                
                return (
                  <button
                    key={p.id}
                    onClick={() => !outOfStock && handleProductTap(p)}
                    disabled={outOfStock}
                    className={`relative overflow-hidden text-left rounded-2xl p-4 border transition-all active:scale-95 ${
                      outOfStock
                        ? "bg-surface border-border opacity-50"
                        : recentlyAdded === p.id
                          ? "bg-success/20 border-warning ring-2 ring-success scale-105"
                          : addedQty > 0
                            ? "bg-success/10 border-success/50"
                            : "bg-surface-overlay border-border hover:bg-surface-overlay"
                    }`}
                  >
                    {addedQty > 0 && !outOfStock && (
                      <span className="absolute top-2 right-2 bg-success-fill text-success-foreground text-xs font-bold min-w-[1.5rem] h-6 px-1 rounded-full flex items-center justify-center shadow-lg pop-anim">
                        {addedQty}
                      </span>
                    )}
                    {p.imagePath && (
                      <img src={assetUrl(p.imagePath)} alt={p.name} className="w-full h-24 object-cover rounded-xl -mt-1 mb-2" />
                    )}
                    <div className="font-semibold text-sm mb-1 pr-6">{p.name}</div>
                    <div className="text-success text-sm font-bold">{formatBRL(p.price)}</div>
                    {outOfStock && (
                      <div className="flex items-center gap-1 text-destructive text-xs font-bold mt-1">
                        <AlertTriangle size={12} /> Sem estoque
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 mb-2 border-b border-border"></div>
          </div>
        )}

        {/* Filtrar produtos frequentes da lista principal para evitar duplicação */}
        {(() => {
          const filteredProductsForMain = frequentProducts.length > 0 && !search && !activeCategory
            ? filteredProducts.filter(p => !frequentProducts.includes(p.id) || recentlyAdded === p.id)
            : filteredProducts;
          
          return (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredProductsForMain.map((p) => {
                const addedQty = cartQtyForProduct(p.id);
                const outOfStock = stockEnabled && p.trackStock && p.quantity <= 0;
                
                return (
                  <button
                    key={p.id}
                    onClick={() => !outOfStock && handleProductTap(p)}
                    disabled={outOfStock}
                    className={`relative overflow-hidden text-left rounded-2xl p-4 border transition-all active:scale-95 ${
                      outOfStock
                        ? "bg-surface border-border opacity-50"
                        : recentlyAdded === p.id
                          ? "bg-success/20 border-warning ring-2 ring-success scale-105"
                          : addedQty > 0
                            ? "bg-success/10 border-success/50"
                            : "bg-surface-overlay border-border hover:bg-surface-overlay"
                    }`}
                  >
                    {addedQty > 0 && !outOfStock && (
                      <span className="absolute top-2 right-2 bg-success-fill text-success-foreground text-xs font-bold min-w-[1.5rem] h-6 px-1 rounded-full flex items-center justify-center shadow-lg pop-anim">
                        {addedQty}
                      </span>
                    )}
                    {p.imagePath && (
                      <img src={assetUrl(p.imagePath)} alt={p.name} className="w-full h-24 object-cover rounded-xl -mt-1 mb-2" />
                    )}
                    <div className="font-semibold text-sm mb-1 pr-6">{p.name}</div>
                    <div className="text-success text-sm font-bold">{formatBRL(p.price)}</div>
                    {p.description && <div className="text-text-muted text-xs mt-1 line-clamp-2">{p.description}</div>}
                    {p.variations?.length > 0 && <div className="text-text-muted text-xs mt-1">Opções disponíveis</div>}
                    {outOfStock && (
                      <div className="flex items-center gap-1 text-destructive text-xs font-bold mt-1">
                        <AlertTriangle size={12} /> Sem estoque
                      </div>
                    )}
                  </button>
                );
              })}
              {catalogLoading && (
                <div className="col-span-full text-text-muted text-center py-12 text-sm">Carregando catálogo…</div>
              )}
              {!catalogLoading && catalogError && (
                <div className="col-span-full flex flex-col items-center gap-3 text-center py-12">
                  <AlertTriangle size={22} className="text-primary" />
                  <div className="text-text-secondary text-sm">Não foi possível carregar o catálogo.</div>
                  <button
                    onClick={loadCatalog}
                    className="bg-surface-overlay hover:bg-surface-overlay border border-border text-foreground text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                  >
                    Tentar novamente
                  </button>
                </div>
              )}
              {!catalogLoading && !catalogError && filteredProductsForMain.length === 0 && (
                <div className="col-span-full text-text-muted text-center py-12 text-sm">Nenhum produto encontrado.</div>
              )}
            </div>
          );
        })()}
      </div>

      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-border bg-surface z-30">
          <button
            onClick={() => setReviewOpen(true)}
            className="w-full flex items-center justify-between bg-success-fill hover:bg-success-fill-strong text-success-foreground font-semibold py-3.5 px-5 rounded-xl transition-colors"
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
          count={cartCount}
          kitchenEnabled={storeSettings?.kitchenEnabled ?? true}
          onClose={() => setReviewOpen(false)}
          onRemoveLine={(key) => setCart((prev) => { const next = { ...prev }; delete next[key]; return next; })}
          onChangeNotes={changeNotes}
          onChangeQty={changeQty}
          onConfirm={handleConfirmBatch}
        />
      )}

      {confirming && (
        <div className="fixed inset-0 bg-surface/97 flex flex-col items-center justify-center z-50 pop-anim">
          <div className="w-16 h-16 rounded-full bg-success/15 border border-success/40 flex items-center justify-center mb-4">
            <Check size={28} className="text-success" />
          </div>
          <div className="font-display text-lg font-bold">Itens adicionados!</div>
        </div>
      )}

      {showExitConfirmation && (
        <ConfirmModal
          title="Sair do lançamento?"
          message={`Você tem ${cartCount} ${cartCount === 1 ? 'item' : 'itens'} no carrinho. Deseja sair e perder as alterações?`}
          confirmLabel="Sair"
          cancelLabel="Continuar editando"
          destructive={true}
          onConfirm={() => {
            setShowExitConfirmation(false);
            onClose();
          }}
          onCancel={() => setShowExitConfirmation(false)}
        />
      )}
    </div>
  );
}