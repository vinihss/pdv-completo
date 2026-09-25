import React, { useState, useCallback, useEffect } from "react";
import { Search, Plus, Eye, EyeOff, ChevronUp, ChevronDown, Trash2, ChefHat } from "lucide-react";
import {
  listCategories, listKitchenGroups, listAllProducts,
  createCategory, updateCategory, deleteCategory,
  createKitchenGroup, updateKitchenGroup, deleteKitchenGroup,
  setProductActive,
} from "@/shared/api/catalog";
import { useAuth } from "@/features/auth";
import { Section, inputClass, ConfirmModal } from "@/shared/components";
import { ProductRow } from "./ProductRow.jsx";
import ProductModal from "./ProductModal.jsx";

export default function CatalogTab({ showToast }) {
  const { storeSettings } = useAuth();
  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const [categories, setCategories] = useState([]);
  const [kitchenGroups, setKitchenGroups] = useState([]);
  const [products, setProducts] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newKitchenGroupName, setNewKitchenGroupName] = useState("");
  const [editingProduct, setEditingProduct] = useState(null); // null | "new" | product
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState(null);
  const [deleteKitchenGroupTarget, setDeleteKitchenGroupTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "uncategorized" | catId
  const [activeFilter, setActiveFilter] = useState("all"); // "all" | "active" | "inactive"

  const load = useCallback(async () => {
    const params = {};
    if (activeFilter === "active") params.active = "true";
    else if (activeFilter === "inactive") params.active = "false";
    if (categoryFilter !== "all" && categoryFilter !== "uncategorized") params.category_id = categoryFilter;
    if (search.trim()) params.q = search.trim();
    const [cats, groups, prods] = await Promise.all([
      listCategories(),
      listKitchenGroups(),
      listAllProducts(params),
    ]);
    setCategories(cats);
    setKitchenGroups(groups);
    setProducts(prods.data);
  }, [search, categoryFilter, activeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddCategory() {
    if (!newCategoryName.trim()) return;
    try {
      await createCategory({ name: newCategoryName.trim(), displayOrder: categories.length });
      setNewCategoryName("");
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRenameCategory(cat, name) {
    try {
      await updateCategory(cat.id, { name });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleToggleCategoryActive(cat) {
    try {
      await updateCategory(cat.id, { active: !cat.active });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleReorder(cat, direction) {
    const sorted = [...categories].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((c) => c.id === cat.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    await Promise.all([
      updateCategory(cat.id, { displayOrder: other.displayOrder }),
      updateCategory(other.id, { displayOrder: cat.displayOrder }),
    ]);
    await load();
  }

  async function handleAddKitchenGroup() {
    if (!newKitchenGroupName.trim()) return;
    try {
      await createKitchenGroup({ name: newKitchenGroupName.trim(), displayOrder: kitchenGroups.length });
      setNewKitchenGroupName("");
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRenameKitchenGroup(group, name) {
    try {
      await updateKitchenGroup(group.id, { name });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleReorderKitchenGroup(group, direction) {
    const sorted = [...kitchenGroups].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((c) => c.id === group.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    await Promise.all([
      updateKitchenGroup(group.id, { displayOrder: other.displayOrder }),
      updateKitchenGroup(other.id, { displayOrder: group.displayOrder }),
    ]);
    await load();
  }

  async function handleToggleProductActive(p) {
    try {
      await setProductActive(p.id, !p.active);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  const productsLinked = (catId) => products.filter((p) => p.categoryId === catId).length;
  const productsInKitchenGroup = (groupId) => products.filter((p) => p.kitchenGroupId === groupId).length;

  async function handleDeleteCategory(cat) {
    try {
      await deleteCategory(cat.id);
      setDeleteCategoryTarget(null);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleDeleteKitchenGroup(group) {
    try {
      await deleteKitchenGroup(group.id);
      setDeleteKitchenGroupTarget(null);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  // "Sem categoria" só faz sentido fora do filtro por categoria específica;
  // busca/ativo já foram aplicados no servidor.
  const sortedProducts = [...products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const categorized = sortedProducts.filter((p) => p.categoryId);
  const uncategorized =
    categoryFilter === "uncategorized"
      ? sortedProducts.filter((p) => !p.categoryId)
      : [];

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-6">
      <Section title="Categorias">
        <div className="space-y-2">
          {categories
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((cat) => (
              <div key={cat.id} className="flex items-center gap-2 bg-stone-800/60 rounded-xl px-3 py-2">
                <input
                  defaultValue={cat.name}
                  onBlur={(e) => e.target.value !== cat.name && handleRenameCategory(cat, e.target.value)}
                  className="flex-1 bg-transparent text-sm font-medium outline-none"
                />
                <button onClick={() => handleToggleCategoryActive(cat)} title={cat.active ? "Desativar" : "Ativar"} className="text-stone-500 hover:text-amber-400">
                  {cat.active ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                <button onClick={() => handleReorder(cat, "up")} className="text-stone-500 hover:text-stone-300"><ChevronUp size={16} /></button>
                <button onClick={() => handleReorder(cat, "down")} className="text-stone-500 hover:text-stone-300"><ChevronDown size={16} /></button>
                <button onClick={() => setDeleteCategoryTarget(cat)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
              </div>
            ))}
        </div>
        <div className="flex gap-2 pt-2">
          <input
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Nova categoria..."
            className={inputClass}
          />
          <button onClick={handleAddCategory} className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-4 rounded-xl font-semibold shrink-0">
            <Plus size={16} />
          </button>
        </div>
        {categories.some((c) => !c.active) && (
          <p className="text-stone-600 text-xs">Categorias desativadas não aparecem no cardápio público, mas continuam no app do garçom.</p>
        )}
      </Section>

      {kitchenEnabled && (
        <Section title="Grupos de produção">
          <div className="space-y-2">
          {kitchenGroups
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((group) => (
              <div key={group.id} className="flex items-center gap-2 bg-stone-800/60 rounded-xl px-3 py-2">
                <ChefHat size={15} className="text-stone-600 shrink-0" />
                <input
                  defaultValue={group.name}
                  onBlur={(e) => e.target.value !== group.name && handleRenameKitchenGroup(group, e.target.value)}
                  className="flex-1 bg-transparent text-sm font-medium outline-none"
                />
                <button onClick={() => handleReorderKitchenGroup(group, "up")} className="text-stone-500 hover:text-stone-300"><ChevronUp size={16} /></button>
                <button onClick={() => handleReorderKitchenGroup(group, "down")} className="text-stone-500 hover:text-stone-300"><ChevronDown size={16} /></button>
                <button onClick={() => setDeleteKitchenGroupTarget(group)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
              </div>
            ))}
          {kitchenGroups.length === 0 && (
            <p className="text-stone-600 text-xs">Nenhum grupo cadastrado. Produtos sem grupo não entram no fluxo da cozinha.</p>
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <input
            value={newKitchenGroupName}
            onChange={(e) => setNewKitchenGroupName(e.target.value)}
            placeholder="Novo grupo (ex.: Cozinha, Grelha, Bar)..."
            className={inputClass}
          />
          <button onClick={handleAddKitchenGroup} className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-4 rounded-xl font-semibold shrink-0">
            <Plus size={16} />
          </button>
        </div>
      </Section>
    )}

    <Section title="Produtos">
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar produto..."
              className={inputClass + " pl-9"}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            <option value="all">Todas as categorias</option>
            <option value="uncategorized">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            <option value="all">Todos</option>
            <option value="active">Disponíveis</option>
            <option value="inactive">Indisponíveis</option>
          </select>
        </div>

        <div className="space-y-2">
          {categorized.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              categoryName={p.categoryName ?? "Sem categoria"}
              ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
              kitchenEnabled={kitchenEnabled}
              onOpen={() => setEditingProduct(p)}
              onToggleActive={() => handleToggleProductActive(p)}
            />
          ))}

          {uncategorized.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-bold uppercase tracking-widest text-amber-500/80 mb-2 px-1">
                Sem categoria ({uncategorized.length}) — reatribua no formulário
              </div>
              {uncategorized.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  categoryName="Sem categoria"
                  ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
                  kitchenEnabled={kitchenEnabled}
                  onOpen={() => setEditingProduct(p)}
                  onToggleActive={() => handleToggleProductActive(p)}
                />
              ))}
            </div>
          )}

          {categorized.length === 0 && uncategorized.length === 0 && (
            <div className="text-stone-600 text-center py-12 text-sm">Nenhum produto encontrado.</div>
          )}
        </div>
        <button
          onClick={() => setEditingProduct("new")}
          className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-semibold py-2.5 rounded-xl"
        >
          <Plus size={16} /> Novo produto
        </button>
      </Section>

      {editingProduct && (
        <ProductModal
          product={editingProduct === "new" ? null : editingProduct}
          categories={categories}
          kitchenGroups={kitchenGroups}
          kitchenEnabled={kitchenEnabled}
          ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
          inventoryEnabled={storeSettings?.inventoryEnabled ?? false}
          onClose={() => setEditingProduct(null)}
          onSaved={async () => {
            setEditingProduct(null);
            await load();
          }}
          showToast={showToast}
        />
      )}

      {deleteCategoryTarget && (
        <ConfirmModal
          title="Excluir categoria?"
          message={`"${deleteCategoryTarget.name}" será excluída. ${
            productsLinked(deleteCategoryTarget.id) > 0
              ? `${productsLinked(deleteCategoryTarget.id)} produto(s) ficarão sem categoria até reatribuição.`
              : "Nenhum produto está vinculado a ela."
          }`}
          confirmLabel="Excluir"
          onCancel={() => setDeleteCategoryTarget(null)}
          onConfirm={() => handleDeleteCategory(deleteCategoryTarget)}
        />
      )}

      {deleteKitchenGroupTarget && (
        <ConfirmModal
          title="Excluir grupo de produção?"
          message={`${productsInKitchenGroup(deleteKitchenGroupTarget.id)} produto(s) pararão de ir para a cozinha até reatribuição.`}
          confirmLabel="Excluir"
          onCancel={() => setDeleteKitchenGroupTarget(null)}
          onConfirm={() => handleDeleteKitchenGroup(deleteKitchenGroupTarget)}
        />
      )}
    </div>
  );
}