import React, { useState } from "react";
import { Package, Upload, ImageOff, X, Plus, Trash2 } from "lucide-react";
import {
  updateProduct, createProduct, uploadProductImage, removeProductImage,
} from "@/shared/api/catalog";
import { formatBRL, parseBRL, maskCurrencyInput } from "@/shared/lib";
import { Field, ToggleRow, inputClass } from "@/shared/components";

export default function ProductModal({ product, categories, kitchenGroups, kitchenEnabled, ifoodIntegrationEnabled, onClose, onSaved, showToast }) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(product ? formatBRL(product.price) : "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? "");
  const [kitchenGroupId, setKitchenGroupId] = useState(product?.kitchenGroupId ?? "");
  // Variações estruturadas: [{ name, options, required, allowMultiple }]
  const [variationGroups, setVariationGroups] = useState(() =>
    (product?.variations ?? []).map((g, i) => ({
      id: `g${i}`,
      name: g?.name ?? "",
      options: Array.isArray(g?.options) ? [...g.options] : [],
      required: Boolean(g?.required),
      allowMultiple: Boolean(g?.allowMultiple),
    }))
  );
  const [newOption, setNewOption] = useState({});
  const [active, setActive] = useState(product?.active ?? true);
  const [ifoodEnabled, setIfoodEnabled] = useState(product?.ifoodEnabled ?? false);
  const [ifoodSku, setIfoodSku] = useState(product?.ifoodSku ?? "");
  const [image, setImage] = useState({ file: null, preview: product?.imagePath ?? "" });
  const [removeImage, setRemoveImage] = useState(false);
  const [saving, setSaving] = useState(false);

  const categoryOptions = categories.filter((c) => c.active || c.id === product?.categoryId);

  function addVariationGroup() {
    setVariationGroups((prev) => [
      ...prev,
      { id: `g${Date.now()}`, name: "", options: [], required: false, allowMultiple: false },
    ]);
  }
  function updateVariationGroup(id, patch) {
    setVariationGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }
  function addOption(gi) {
    const value = newOption[gi]?.trim();
    if (!value) return;
    setVariationGroups((prev) =>
      prev.map((g, idx) => (idx === gi ? { ...g, options: [...g.options, value] } : g))
    );
    setNewOption((prev) => ({ ...prev, [gi]: "" }));
  }
  function removeOption(gi, oi) {
    setVariationGroups((prev) =>
      prev.map((g, idx) => (idx === gi ? { ...g, options: g.options.filter((_, i) => i !== oi) } : g))
    );
  }
  function removeVariationGroup(id) {
    setVariationGroups((prev) => prev.filter((g) => g.id !== id));
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRemoveImage(false);
    setImage({ file, preview: URL.createObjectURL(file) });
  }

  function handleRemoveImage() {
    setImage({ file: null, preview: "" });
    setRemoveImage(true);
  }

  async function handleSave() {
    if (!name.trim()) {
      showToast("Informe o nome do produto.", "error");
      return;
    }
    if (!categoryId && !product) {
      showToast("Crie ao menos uma categoria antes de cadastrar o produto.", "error");
      return;
    }
    setSaving(true);
    try {
      const variations = variationGroups
        .map((g) => ({
          name: g.name.trim(),
          options: g.options.map((o) => o.trim()).filter(Boolean),
          required: g.required,
          allowMultiple: g.allowMultiple,
        }))
        .filter((g) => g.name && g.options.length > 0);
      const body = {
        name: name.trim(),
        description: description.trim(),
        price: parseBRL(price),
        categoryId: categoryId || null,
        kitchenGroupId: kitchenEnabled ? kitchenGroupId || null : null,
        variations,
        active,
        ifoodEnabled: ifoodIntegrationEnabled ? ifoodEnabled : false,
        ifoodSku: ifoodIntegrationEnabled && ifoodEnabled ? ifoodSku.trim() : null,
      };
      let productId = product?.id;
      if (product) await updateProduct(product.id, body);
      else {
        const created = await createProduct(body);
        productId = created.id;
      }
      if (image.file) await uploadProductImage(productId, image.file);
      else if (removeImage) await removeProductImage(productId);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-md bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">{product ? "Editar produto" : "Novo produto"}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5">
          <Field label="Foto do produto">
            <div className="flex items-center gap-3">
              {image.preview ? (
                <img src={image.preview} alt="Prévia do produto" className="w-16 h-16 rounded-xl object-cover shrink-0" />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
                  <Package size={24} />
                </div>
              )}
              <div className="flex-1 space-y-2">
                <label className="flex items-center justify-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-sm font-medium cursor-pointer">
                  <Upload size={14} /> {image.file || product?.imagePath ? "Trocar foto" : "Enviar foto"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileChange} />
                </label>
                {(image.file || product?.imagePath) && (
                  <button onClick={handleRemoveImage} className="flex items-center gap-1.5 text-red-400 text-xs font-medium">
                    <ImageOff size={13} /> Remover foto
                  </button>
                )}
              </div>
            </div>
          </Field>
          <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
          <Field label="Descrição"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Ex.: Prato do dia com arroz, feijão e salada..." className={inputClass + " resize-none"} /></Field>
          <Field label="Preço"><input inputMode="numeric" value={price} onChange={(e) => setPrice(maskCurrencyInput(e.target.value))} placeholder="R$ 0,00" className={inputClass} /></Field>
          <Field label="Categoria">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              <option value="">{product ? "— Sem categoria —" : "Selecione uma categoria..."}</option>
              {categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Grupo de produção (cozinha)">
            {kitchenEnabled ? (
              <>
                <select value={kitchenGroupId} onChange={(e) => setKitchenGroupId(e.target.value)} className={inputClass}>
                  <option value="">Nenhum — não vai para a cozinha</option>
                  {kitchenGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <div className="text-stone-600 text-xs mt-1">Itens deste produto só aparecem na tela da cozinha se um grupo for escolhido.</div>
              </>
            ) : (
              <div className="text-stone-600 text-xs bg-stone-800/50 border border-stone-800 rounded-xl px-3 py-2.5">
                Configuração atual: restaurante sem cozinha — este produto entra na comanda pronto, sem passagem por estação.
              </div>
            )}
          </Field>
          <Field label="Variações (opcional)">
            <div className="space-y-2">
              {variationGroups.map((g, gi) => (
                <div key={g.id} className="bg-stone-800/60 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={g.name}
                      onChange={(e) => updateVariationGroup(g.id, { name: e.target.value })}
                      placeholder="Nome do grupo (ex.: Ponto da carne)"
                      className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-500/50"
                    />
                    <button onClick={() => removeVariationGroup(g.id)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.options.map((opt, oi) => (
                      <span key={oi} className="flex items-center gap-1 bg-stone-900 border border-stone-700 rounded-full pl-2.5 pr-1 py-1 text-xs">
                        {opt}
                        <button onClick={() => removeOption(gi, oi)} className="text-stone-500 hover:text-red-400"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={newOption[gi] ?? ""}
                      onChange={(e) => setNewOption((prev) => ({ ...prev, [gi]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(gi); } }}
                      placeholder="Nova opção (Enter para adicionar)..."
                      className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-500/50"
                    />
                    <button onClick={() => addOption(gi)} className="bg-stone-900 border border-stone-700 rounded-lg px-2.5 text-stone-300 hover:text-amber-400"><Plus size={14} /></button>
                  </div>
                  <div className="flex gap-4 text-xs text-stone-400">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={g.required} onChange={(e) => updateVariationGroup(g.id, { required: e.target.checked })} /> Obrigatória</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={g.allowMultiple} onChange={(e) => updateVariationGroup(g.id, { allowMultiple: e.target.checked })} /> Permitir múltiplas</label>
                  </div>
                </div>
              ))}
              <button onClick={addVariationGroup} className="flex items-center gap-1.5 text-amber-500 text-sm font-semibold">
                <Plus size={14} /> Adicionar variação
              </button>
            </div>
          </Field>
          <div className="space-y-3 bg-stone-800/40 border border-stone-800 rounded-xl p-3">
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Habilitado para venda</div>
                  <div className="text-stone-600 text-xs">Desligado, o produto some das telas de venda (garçom, cardápio público e cozinha).</div>
                </div>
                <button
                  onClick={() => setActive(!active)}
                  className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${active ? "bg-amber-500" : "bg-stone-700"}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${active ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
            </div>
            <div className="border-t border-stone-800 pt-3">
              {ifoodIntegrationEnabled ? (
                <ToggleRow label="Disponível no iFood" checked={ifoodEnabled} onChange={setIfoodEnabled} />
              ) : (
                <div className="text-stone-600 text-xs">
                  Integração com iFood desabilitada nas configurações — a flag não se aplica a este produto.
                </div>
              )}
            </div>
          </div>
          {ifoodIntegrationEnabled && ifoodEnabled && (
            <Field label="Código no iFood (SKU)">
              <input value={ifoodSku} onChange={(e) => setIfoodSku(e.target.value)} placeholder="Ex.: 5f3a0e1a-9d4c..." className={inputClass} />
            </Field>
          )}
        </div>
        <button onClick={handleSave} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </div>
  );
}