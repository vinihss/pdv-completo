import { orderLabel, orderTotal } from "@/entities/order";
import { analyzePixKey, buildPixPayload } from "@/entities/payment";
import { formatBRL } from "@/shared/lib";
import { AlertTriangle } from "lucide-react";
import QRCode from "qrcode";
import React, { useState, useEffect } from "react";

export default function PixQrScreen({
  order,
  amount,
  storeSettings,
  onBack,
  onConfirm,
  submitting,
}) {
  const [dataUrl, setDataUrl] = useState(null);
  const value = amount ?? orderTotal(order);
  const { warnings } = analyzePixKey(storeSettings.pixKey, storeSettings.pixKeyType);
  const payload = buildPixPayload({
    pixKey: storeSettings.pixKey,
    pixKeyType: storeSettings.pixKeyType,
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
        <div className="text-text-secondary text-sm mb-1">Escaneie o QR com o app do banco</div>
        <div className="font-display text-3xl font-bold text-success">{formatBRL(value)}</div>
      </div>
      <div className="flex justify-center my-5">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="QR Code Pix"
            className="w-[220px] h-[220px] rounded-2xl bg-white p-2"
          />
        ) : (
          <div className="w-[220px] h-[220px] rounded-2xl bg-surface-overlay animate-pulse" />
        )}
      </div>
      <div className="text-center text-xs text-text-muted mb-4">
        Confira o recebimento no extrato do banco antes de confirmar.
      </div>
      {warnings.length > 0 && (
        <div className="mb-4 text-sm bg-primary/10 border border-ring/30 text-primary rounded-xl px-3 py-2.5">
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 bg-surface-overlay text-text-secondary font-semibold py-3 rounded-xl"
        >
          Voltar
        </button>
        <button
          onClick={onConfirm}
          disabled={submitting}
          className="flex-1 bg-success hover:bg-success disabled:opacity-50 text-primary-foreground font-semibold py-3 rounded-xl"
        >
          {submitting ? "Confirmando…" : "Confirmar recebimento"}
        </button>
      </div>
    </div>
  );
}
