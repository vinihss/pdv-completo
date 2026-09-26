import React, { useEffect, useState } from "react";
import { getCashDrawerDetail } from "@/entities/cash";
import { getStoreInfo } from "@/entities/store";
import { toDate } from "@/shared/lib";
import { formatBRL } from "@/shared/lib";


function line({ label, value, strong }) {
  return (
    <div className="flex justify-between py-0.5 text-[12px]">
      <span>{label}</span>
      <span className={strong ? "font-bold" : ""}>{value}</span>
    </div>
  );
}

// Cupom de fechamento (Z). Monta o conteúdo dentro de #print-root e dispara
// window.print() assim que carrega; a regra @media print em index.css esconde
// o resto da interface. `onDone` é chamado após emitir a impressão.
export default function PrintReceipt({ drawerId, onDone }) {
  const [detail, setDetail] = useState(null);
  const [storeName, setStoreName] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([getCashDrawerDetail(drawerId), getStoreInfo().catch(() => null)])
      .then(([d, store]) => {
        if (cancelled) return;
        setDetail(d);
        setStoreName(store?.merchantName ?? "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [drawerId]);

  useEffect(() => {
    if (!detail) return;
    const t = setTimeout(() => {
      window.print();
      onDone?.();
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  if (!detail) return null;

  const diff = detail.closingDifference ?? 0;

  return (
    <div id="print-root">
      <div className="max-w-sm mx-auto bg-white text-black p-6 font-mono">
        <h1 className="text-center text-base font-bold tracking-wide">{storeName || "PDV"}</h1>
        <p className="text-center text-[11px] mb-3 tracking-widest">FECHAMENTO DE CAIXA</p>

        {line({ label: "Aberto", value: toDate(detail.openedAt)?.toLocaleString() ?? "—" })}
        {line({ label: "Fechado", value: toDate(d.closedAt)?.toLocaleString() ?? "—" })}
        {line({ label: "Operador", value: detail.openedByName ?? "—" })}
        <div className="border-b border-dashed border-black my-2" />

        {line({ label: "Fundo inicial", value: formatBRL(detail.openingAmount) })}
        {line({ label: "Vendas em dinheiro", value: formatBRL(detail.cashSalesTotal) })}
        {line({ label: "Esperado", value: formatBRL(detail.closingExpected ?? detail.expectedCash), strong: true })}
        {line({ label: "Contado", value: formatBRL(detail.closingCounted) })}
        {line({ label: "Diferença", value: `${diff > 0 ? "+" : ""}${formatBRL(diff)}`, strong: true })}
        {detail.closingNote && line({ label: "Observação", value: detail.closingNote })}

        {detail.cashSales.length > 0 && (
          <>
            <div className="border-b border-dashed border-black my-2" />
            {detail.cashSales.map((s) => (
              <div key={s.orderId} className="flex justify-between text-[11px] py-0.5">
                <span className="truncate pr-2">{s.label}</span>
                <span>{formatBRL(s.amount)}</span>
              </div>
            ))}
          </>
        )}

        {detail.movements.length > 0 && (
          <>
            <div className="border-b border-dashed border-black my-2" />
            {detail.movements.map((m) => (
              <div key={m.id} className="flex justify-between text-[11px] py-0.5">
                <span className="truncate pr-2">
                  {m.type === "sangria" ? "Sangria " : "Suprimento "}
                  {m.refOrderLabel ? `(${m.refOrderLabel})` : ""}
                  {m.note ? ` — ${m.note}` : ""}
                </span>
                <span>{m.type === "sangria" ? "−" : "+"} {formatBRL(m.amount)}</span>
              </div>
            ))}
          </>
        )}

        <div className="text-center text-[10px] mt-4 tracking-widest">Este reforço não é um documento fiscal.</div>
      </div>
    </div>
  );
}