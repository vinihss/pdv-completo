import React, { useState, useEffect } from "react";
import QRCode from "qrcode";
import { AlertTriangle } from "lucide-react";
import { analyzePixKey, buildPixPayload } from "@/entities/payment";
import { orderTotal, orderLabel } from "@/entities/order";
import { formatBRL } from "@/shared/lib";

export default function PixQrScreen({ order, amount, storeSettings, onBack, onConfirm, submitting }) {
  const [dataUrl, setDataUrl] = useState(null);
  const value = amount ?? orderTotal(order);
  const { warnings } = analyzePixKey(storeSettings.pixKey);
  const payload = buildPixPayload({
    pixKey: storeSettings.pixKey,
    merchantName: storeSettings.merchantName,
    merchantCity: storeSettings.merchantCity,
    amount: value,
    txid: order.id,
    description: orderLabel(order),
  });

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(payload, { width: 220, margin: 1 })
      .then((url) => alive && setDataUrl(url))
      .catch(() => alive && setDataUrl(null));
    return () => {
      alive = false;
    };
  }, [payload]);

  return (
    <div>
      <div className="text-center pt-1">
        <div className="text-stone-400 text-sm mb-1">Escaneie o QR com o app do banco</div>
        <div className="font-display text-3xl font-bold text-emerald-400">{formatBRL(value)}</div>
      </div>
      <div className="flex justify-center my-5">
        {dataUrl ? (
          <img src={dataUrl} alt="QR Code Pix" className="w-[220px] h-[220px] rounded-2xl bg-white p-2" />
        ) : (
          <div className="w-[220px] h-[220px] rounded-2xl bg-stone-800 animate-pulse" />
        )}
      </div>
      <div className="text-center text-xs text-stone-500 mb-4">
        Confira o recebimento no extrato do banco antes de confirmar.
      </div>
      {warnings.length > 0 && (
        <div className="mb-4 text-sm bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl px-3 py-2.5">
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onBack} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-3 rounded-xl">
          Voltar
        </button>
        <button
          onClick={onConfirm}
          disabled={submitting}
          className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl"
        >
          {submitting ? "Confirmando…" : "Confirmar recebimento"}
        </button>
      </div>
    </div>
  );
}