import React, { useState, useEffect } from "react";
import { Upload, ImageOff, Store, RefreshCcw, AlertTriangle } from "lucide-react";
import { updateStoreSettings, uploadStoreLogo, removeStoreLogo } from "@/shared/api/store";
import { useAuth } from "@/features/auth";
import { applyBrandPrimary, DEFAULT_PRIMARY_COLOR } from "@/shared/lib";
import { Section, Field, ToggleRow, inputClass } from "@/shared/components";

export default function SettingsTab({ showToast }) {
  const { storeSettings, refreshStoreSettings } = useAuth();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [logoFile, setLogoFile] = useState(null); // arquivo staged (upload no salvar)
  const [logoPreview, setLogoPreview] = useState(""); // prévia staged (object URL)
  const [logoRemoved, setLogoRemoved] = useState(false); // remove o logo no salvar

  useEffect(() => {
    if (storeSettings) setForm(storeSettings);
  }, [storeSettings]);

  if (!form) return <div className="p-6 text-stone-600">Carregando…</div>;

  function set(patch) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function toggleMethod(m) {
    set({
      enabledPaymentMethods: form.enabledPaymentMethods.includes(m)
        ? form.enabledPaymentMethods.filter((x) => x !== m)
        : [...form.enabledPaymentMethods, m],
    });
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      await updateStoreSettings(form);
      if (logoFile) await uploadStoreLogo(logoFile);
      else if (logoRemoved) await removeStoreLogo();
      await refreshStoreSettings();
      setLogoFile(null);
      setLogoRemoved(false);
      showToast("Configurações salvas.", "success");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoRemoved(false);
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  }

  function handleRemoveLogo() {
    setLogoFile(null);
    setLogoPreview("");
    setLogoRemoved(true);
  }

  const displayLogo = logoRemoved ? "" : logoPreview || form.logoUrl || "";

  return (
    <div className="p-5 max-w-lg mx-auto space-y-6">
      <Section title="Identidade">
        <Field label="Logo do restaurante">
          <div className="flex items-center gap-3">
            {displayLogo ? (
              <img src={displayLogo} alt="Logo do restaurante" className="w-16 h-16 rounded-xl object-cover shrink-0" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
                <Store size={24} />
              </div>
            )}
            <div className="flex-1 space-y-2">
              <label className="flex items-center justify-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-sm font-medium cursor-pointer">
                <Upload size={14} /> {displayLogo ? "Trocar logo" : "Enviar logo"}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleLogoFile} />
              </label>
              {displayLogo && (
                <button onClick={handleRemoveLogo} className="flex items-center gap-1.5 text-red-400 text-xs font-medium">
                  <ImageOff size={13} /> Remover logo
                </button>
              )}
            </div>
          </div>
        </Field>
        <Field label="Cor principal (marca)">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.brandColor}
              onChange={(e) => {
                set({ brandColor: e.target.value });
                applyBrandPrimary(e.target.value);
              }}
              className="h-11 w-14 rounded-lg bg-stone-800 border border-stone-700 cursor-pointer shrink-0"
            />
            <span className="text-sm font-mono text-stone-400">{form.brandColor}</span>
            <button
              onClick={() => {
                set({ brandColor: DEFAULT_PRIMARY_COLOR });
                applyBrandPrimary();
              }}
              className="ml-auto flex items-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-xs font-semibold text-stone-300 transition-colors"
            >
              <RefreshCcw size={13} /> Restaurar padrão
            </button>
          </div>
          <p className="text-stone-600 text-xs mt-1.5">Aplica nos botões principais, destaques e na página externa de pedidos.</p>
        </Field>
        <Field label="Nome do estabelecimento (máx. 25)">
          <input maxLength={25} value={form.merchantName} onChange={(e) => set({ merchantName: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Cidade (máx. 15)">
          <input maxLength={15} value={form.merchantCity} onChange={(e) => set({ merchantCity: e.target.value })} className={inputClass} />
        </Field>
      </Section>

      <Section title="Modo de operação">
        <ToggleRow label="Usa mesas" checked={form.usesTables} onChange={(v) => set({ usesTables: v })} />
        <ToggleRow label="Cozinha habilitada" checked={form.kitchenEnabled} onChange={(v) => set({ kitchenEnabled: v })} />
        <ToggleRow label="Integração iFood" checked={form.ifoodIntegrationEnabled} onChange={(v) => set({ ifoodIntegrationEnabled: v })} />
        <ToggleRow
          label="Controle de estoque"
          checked={form.inventoryEnabled}
          onChange={(v) => set({ inventoryEnabled: v })}
        />
        <ToggleRow
          label="Compras / fornecedores"
          checked={form.purchaseEnabled}
          onChange={(v) => set({ purchaseEnabled: v })}
        />
        <p className="text-stone-600 text-xs">
          Em produtos com "Rastreia estoque" ativo, o lançamento de item debita o saldo e bloqueia quando insuficiente; a aba
          Estoque do gerente permite compras e ajustes. Desligar não apaga o histórico de movimentos.
        </p>
      </Section>

      <Section title="Entrega (WhatsApp / página externa)">
        <ToggleRow label="Usa delivery (página de pedido externa)" checked={form.usesDelivery} onChange={(v) => set({ usesDelivery: v })} />
        {form.usesDelivery && (
          <Field label="Taxa de entrega (R$)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.deliveryFee}
              onChange={(e) => set({ deliveryFee: Number(e.target.value) })}
              className={inputClass}
            />
          </Field>
        )}
      </Section>

      {form.kitchenEnabled && (
        <Section title="Limiares de tempo (cozinha)">
          <Field label="Alerta (preparo) — min">
            <input type="number" value={form.kitchenPrepWarnMin} onChange={(e) => set({ kitchenPrepWarnMin: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Urgente (preparo) — min">
            <input type="number" value={form.kitchenPrepUrgentMin} onChange={(e) => set({ kitchenPrepUrgentMin: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Urgente (retirada) — min">
            <input type="number" value={form.kitchenPickupUrgentMin} onChange={(e) => set({ kitchenPickupUrgentMin: Number(e.target.value) })} className={inputClass} />
          </Field>
        </Section>
      )}

      <Section title="Formas de pagamento">
        <div className="grid grid-cols-2 gap-2">
          {["cash", "card", "pix", "other"].map((m) => (
            <button
              key={m}
              onClick={() => toggleMethod(m)}
              className={`py-2.5 rounded-xl text-sm font-semibold border ${
                form.enabledPaymentMethods.includes(m) ? "bg-amber-500 text-stone-950 border-amber-500" : "bg-stone-900 border-stone-800 text-stone-400"
              }`}
            >
              {{ cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[m]}
            </button>
          ))}
        </div>
      </Section>

      {form.enabledPaymentMethods.includes("pix") && (
        <Section title="Pix (QR local)">
          <Field label="Chave Pix">
            <input value={form.pixKey} onChange={(e) => set({ pixKey: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Tipo da chave">
            <select value={form.pixKeyType} onChange={(e) => set({ pixKeyType: e.target.value })} className={inputClass}>
              {["cpf", "cnpj", "email", "phone", "random"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </Section>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2.5">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
      >
        {saving ? "Salvando…" : "Salvar configurações"}
      </button>
    </div>
  );
}