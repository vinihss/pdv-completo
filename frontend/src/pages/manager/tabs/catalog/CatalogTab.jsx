import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Search, Plus, Eye, EyeOff, ChevronUp, ChevronDown, ChevronsUpDown, ChevronsDownUp, Trash2, ChefHat, Filter, X } from "lucide-react";
import { listCategories, createCategory, updateCategory, deleteCategory } from "@/entities/category";
import { listKitchenGroups, createKitchenGroup, updateKitchenGroup, deleteKitchenGroup } from "@/entities/kitchen-group";
import { listAllProducts, setProductActive } from "@/entities/product";
import { useAuth } from "@/app/providers/auth";
import { Section, inputClass, ConfirmModal } from "@/shared/components";
import { ProductRow } from "./ProductRow.jsx";
import ProductModal from "./ProductModal.jsx";

const SORT_OPTIONS = [
  { value: "name", label: "Nome (A-Z)" },
  { value: "price_asc", label: "Preço (menor primeiro)" },
  { value: "price_desc", label: "Preço (maior primeiro)" },
];

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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "uncategorized" | catId
  const [activeFilter, setActiveFilter] = useState("all"); // "all" | "active" | "inactive"
  const [sort, setSort] = useState("name");
  const [collapsedCats, setCollapsedCats] = useState(() => new Set());
  const [catsSectionOpen, setCatsSectionOpen] = useState(false);

  // Debounce da busca: digitar não dispara request a cada tecla.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const params = { sort };
    if (activeFilter === "active") params.active = "true";
    else if (activeFilter === "inactive") params.active = "false";
    if (categoryFilter !== "all" && categoryFilter !== "uncategorized") params.category_id = categoryFilter;
    if (debouncedSearch.trim()) params.q = debouncedSearch.trim();
    const [cats, groups, prods] = await Promise.all([
      listCategories(),
      listKitchenGroups(),
      listAllProducts(params),
    ]);
    setCategories(cats);
    setKitchenGroups(groups);
    setProducts(prods.data);
  }, [debouncedSearch, categoryFilter, activeFilter, sort]);

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
  // busca/ativo/ordenação já foram aplicados no servidor.
  const sortedProducts = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [products]
  );
  const visibleCount = sortedProducts.length;

  // Agrupa por categoria respeitando o filtro: com categoria escolhida, só o
  // bloco dela; sem filtro, todos + "Sem categoria" no final.
  const blocks = useMemo(() => {
    const cats = categories
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((cat) => ({
        key: cat.id,
        title: cat.name,
        active: cat.active,
        products: sortedProducts.filter((p) => p.categoryId === cat.id),
      }))
      .filter((b) => (categoryFilter === "all" ? true : categoryFilter === b.key));
    const uncat = sortedProducts.filter((p) => !p.categoryId);
    if (categoryFilter === "all" || categoryFilter === "uncategorized") {
      if (uncat.length > 0 || categoryFilter === "uncategorized") {
        cats.push({ key: "uncategorized", title: "Sem categoria", active: true, products: uncat });
      }
    }
    return cats;
  }, [categories, sortedProducts, categoryFilter]);

  function toggleCatCollapse(key) {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    setCollapsedCats(new Set());
  }

  function collapseAll() {
    setCollapsedCats(new Set(blocks.map((b) => b.key)));
  }

  const hasFilters = search.trim() !== "" || categoryFilter !== "all" || activeFilter !== "all" || sort !== "name";

  function clearFilters() {
    setSearch("");
    setCategoryFilter("all");
    setActiveFilter("all");
    setSort("name");
  }

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-6">
      {/* Categorias e grupos de produção: gestão secundária, começa recolhida */}
      <Section
        title="Categorias"
        collapsed={!catsSectionOpen}
        onToggle={() => setCatsSectionOpen(!catsSectionOpen)}
      >
        <div className="space-y-2">
          {categories.map((cat) => (
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
        <Section title="Grupos de produção" collapsed={!catsSectionOpen} onToggle={() => setCatsSectionOpen(!catsSectionOpen)}>
          <div className="space-y-2">
            {kitchenGroups.map((group) => (
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

      <Section title={`Produtos (${visibleCount})`}>
        <div className="flex gap-2 flex-wrap items-center">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar produto (ignora acentos)..."
              className={inputClass + " pl-9"}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Limpar busca"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <Filter size={15} className="text-stone-600 shrink-0" />
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
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="text-xs font-semibold text-stone-400 hover:text-amber-400 shrink-0"
            >
              Limpar
            </button>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <button onClick={expandAll} className="flex items-center gap-1 text-[11px] font-semibold text-stone-500 hover:text-stone-300">
            <ChevronsUpDown size={12} /> Expandir tudo
          </button>
          <button onClick={collapseAll} className="flex items-center gap-1 text-[11px] font-semibold text-stone-500 hover:text-stone-300">
            <ChevronsDownUp size={12} /> Recolher tudo
          </button>
        </div>

        <div className="space-y-3">
          {blocks.map((block) => {
            const collapsed = collapsedCats.has(block.key);
            return (
              <div key={block.key} className="border border-stone-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => toggleCatCollapse(block.key)}
                  aria-expanded={!collapsed}
                  className="w-full flex items-center gap-2 bg-stone-900 px-3 py-2.5 text-left hover:bg-stone-800/60 transition-colors"
                >
                  <ChevronDown size={15} className={`text-stone-500 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                  <span className="flex-1 text-sm font-semibold truncate">{block.title}</span>
                  {!block.active && (
                    <span className="text-[10px] font-bold text-stone-500 bg-stone-700/60 rounded-full px-1.5 py-0.5">inativa</span>
                  )}
                  <span className="text-xs text-stone-500 shrink-0">{block.products.length}</span>
                </button>
                {!collapsed && (
                  <div className="p-2 space-y-1.5 bg-stone-950/40">
                    {block.products.map((p) => (
                      <ProductRow
                        key={p.id}
                        product={p}
                        categoryName={p.categoryName ?? "Sem categoria"}
                        ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
                        deliveryEnabled={storeSettings?.usesDelivery ?? false}
                        kitchenEnabled={kitchenEnabled}
                        onOpen={() => setEditingProduct(p)}
                        onToggleActive={() => handleToggleProductActive(p)}
                      />
                    ))}
                    {block.products.length === 0 && (
                      <div className="text-stone-600 text-center py-6 text-xs">Nenhum produto neste grupo.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {blocks.length === 0 && (
            <div className="text-stone-600 text-center py-12 text-sm">
              {hasFilters ? "Nenhum produto encontrado para os filtros." : "Nenhum produto cadastrado."}
            </div>
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
