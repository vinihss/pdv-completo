import React, { useState, useEffect } from "react";
import { Upload, ImageOff, Store, RefreshCcw, AlertTriangle } from "lucide-react";
import { updateStoreSettings, uploadStoreLogo, removeStoreLogo } from "@/entities/store";
import { analyzePixKey, PIX_KEY_TYPE_LABELS } from "@/entities/payment";
import { useAuth } from "@/app/providers/auth";
import { applyBrandPrimary, DEFAULT_PRIMARY_COLOR, isDesktop } from "@/shared/lib";
import { Section, Field, ToggleRow, inputClass } from "@/shared/components";
import AppSection from "./AppSection.jsx";

// O que o BR Code vai realmente conter. Sem isso o gerente salva "51991432485"
// como telefone e só descobre o problema quando o cliente tenta pagar: o app do
// banco lê 11 dígitos como CPF e recusa o QR.
function PixKeyPreview({ pixKey, pixKeyType }) {
  const { key, type, warnings } = analyzePixKey(pixKey, pixKeyType);

  if (!key) return null;

  return (
    <div className="text-xs text-stone-400">
      <p>
        Será usada no QR como <span className="text-stone-200 font-medium">{PIX_KEY_TYPE_LABELS[type] ?? "—"}</span>:{" "}
        <span className="font-mono text-stone-200">{key}</span>
      </p>
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 mt-1.5 text-amber-300">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          {w}
        </p>
      ))}
    </div>
  );
}

export default function SettingsTab({ showToast }) {
  const { storeSettings, refreshStoreSettings } = useAuth();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState("");
  const [logoRemoved, setLogoRemoved] = useState(false);

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

      <Section title="Impressão térmica">
        <ToggleRow
          label="Impressão local (daemon)"
          checked={form.printerEnabled ?? false}
          onChange={(v) => set({ printerEnabled: v })}
        />
        {form.printerEnabled && (
          <>
            <ToggleRow
              label="Impressão automática"
              checked={form.printerAutoPrint ?? false}
              onChange={(v) => set({ printerAutoPrint: v })}
            />
            <p className="text-stone-600 text-xs">
              Com a impressão automática ligada, o ticket da cozinha é impresso a cada lançamento de item e o ticket de entrega
              a cada saída para entrega. O ícone de impressão no pedido permite imprimir manualmente a qualquer momento.
            </p>
          </>
        )}
      </Section>

      <Section title="Entrega (WhatsApp / página externa)">
        <ToggleRow label="Usa delivery (página de pedido externa)" checked={form.usesDelivery} onChange={(v) => set({ usesDelivery: v })} />
        {form.usesDelivery && (
          <>
            <Field label="Coordenadas do restaurante">
              {form.restaurantLat != null && form.restaurantLong != null ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-stone-400">{form.restaurantLat.toFixed(5)}, {form.restaurantLong.toFixed(5)}</span>
                  <span className="text-[11px] text-stone-500">(calculada automaticamente)</span>
                </div>
              ) : (
                <p className="text-stone-500 text-xs">Será calculada automaticamente ao salvar nome e cidade.</p>
              )}
            </Field>
            <Field label="Frete grátis acima de (R$) — 0 desativa">
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.freeDeliveryMin ?? 0}
                onChange={(e) => set({ freeDeliveryMin: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
            <Field label="Tabela de frete por distância">
              <div className="space-y-2">
                {(form.deliveryFeeTiers ?? []).map((tier, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-xs text-stone-500 w-16">Até {tier.maxKm}km</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="R$"
                      value={tier.fee}
                      onChange={(e) => {
                        const newTiers = [...(form.deliveryFeeTiers ?? [])];
                        newTiers[idx] = { ...newTiers[idx], fee: Number(e.target.value) };
                        set({ deliveryFeeTiers: newTiers });
                      }}
                      className={inputClass}
                    />
                    <button
                      onClick={() => {
                        const newTiers = (form.deliveryFeeTiers ?? []).filter((_, i) => i !== idx);
                        set({ deliveryFeeTiers: newTiers });
                      }}
                      className="text-red-400 hover:text-red-300 text-xs font-medium"
                    >
                      Remover
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const newTiers = [...(form.deliveryFeeTiers ?? []), { maxKm: 15, fee: 20 }];
                    set({ deliveryFeeTiers: newTiers });
                  }}
                  className="text-xs text-amber-400 hover:text-amber-300 font-medium"
                >
                  + Adicionar faixa
                </button>
              </div>
              <p className="text-stone-600 text-xs mt-1.5">
                A última faixa define o limite máximo de entrega. Acima dela, o endereço é considerado fora da área.
              </p>
            </Field>
            <Field label="Taxa de entrega padrão (R$) — fallback">
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.deliveryFee}
                onChange={(e) => set({ deliveryFee: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
            <Field label="Tempo de preparo (min)">
              <input
                type="number"
                step="1"
                min="1"
                value={form.deliveryPrepMinutes}
                onChange={(e) => set({ deliveryPrepMinutes: Number(e.target.value) })}
                className={inputClass}
              />
              <p className="text-stone-600 text-xs mt-1.5">
                Base da previsão de entrega que o cliente vê na página de pedido. Some-se o tempo de viagem da faixa
                escolhida.
              </p>
            </Field>
            <Field label="Minutos de viagem por km">
              <input
                type="number"
                step="0.5"
                min="0"
                value={form.minutesPerKm}
                onChange={(e) => set({ minutesPerKm: Number(e.target.value) })}
                className={inputClass}
              />
              <p className="text-stone-600 text-xs mt-1.5">
                Multiplicado pelo km máximo da faixa. Na prática 2 é razoável em cidade; ajuste conforme sua região.
              </p>
            </Field>
          </>
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
                <option key={t} value={t}>{PIX_KEY_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </Field>
          <PixKeyPreview pixKey={form.pixKey} pixKeyType={form.pixKeyType} />
        </Section>
      )}

      {isDesktop() && <AppSection showToast={showToast} />}

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