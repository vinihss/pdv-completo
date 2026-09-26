import React, { useState, useEffect } from "react";
import { Printer } from "lucide-react";
import { getCashDrawerDetail } from "@/entities/cash";
import { toDate } from "@/shared/lib";
import { formatBRL } from "@/shared/lib";
import { Modal } from "@/shared/components";


export default function CashDrawerDetailModal({ drawerId, onClose, showToast, onPrint }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    getCashDrawerDetail(drawerId)
      .then(setDetail)
      .catch((e) => showToast(e.message, "error"));
  }, [drawerId, showToast]);

  return (
    <Modal
      title="Detalhe do caixa"
      onClose={onClose}
      headerRight={
        <button
          onClick={() => onPrint?.()}
          title="Imprimir cupom"
          aria-label="Imprimir cupom"
          className="w-10 h-10 flex items-center justify-center rounded-full text-stone-500 hover:text-stone-200 transition-colors shrink-0"
        >
          <Printer size={18} />
        </button>
      }
    >
      <div className="p-5">
        {!detail && <div className="text-stone-600 text-center py-8">Carregando…</div>}

        {detail && (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <MiniStat label="Esperado" value={formatBRL(detail.closingExpected ?? detail.expectedCash)} className="text-stone-200" />
              <MiniStat label="Contado" value={formatBRL(detail.closingCounted)} className="text-stone-200" />
              <MiniStat
                label="Diferença"
                value={`${detail.closingDifference > 0 ? "+" : ""}${formatBRL(detail.closingDifference)}`}
                className={detail.closingDifference === 0 ? "text-emerald-400" : detail.closingDifference > 0 ? "text-emerald-400" : "text-red-400"}
              />
            </div>

            <div className="text-xs text-stone-500 mb-4">
              Aberto por {detail.openedByName ?? "—"} em {toDate(detail.openedAt)?.toLocaleString() ?? "—"} ·{" "}
              fechado por {detail.closedByName ?? "—"} em {toDate(detail.closedAt)?.toLocaleString() ?? "—"}
              {detail.closingNote && (
                <div className="mt-2 text-stone-400 bg-stone-950 border border-stone-800 rounded-xl px-3 py-2">
                  <b>Observação:</b> {detail.closingNote}
                </div>
              )}
            </div>

            <DetailList title={`Vendas em dinheiro (${detail.cashSales.length})`}>
              {detail.cashSales.length === 0 && <Empty text="Nenhuma venda em dinheiro no período." />}
              {detail.cashSales.map((s) => (
                <Row key={s.orderId} title={s.label} sub={s.received != null ? `Recebido ${formatBRL(s.received)} · Troco ${formatBRL(s.change ?? 0)}` : undefined}>
                  <span className="text-emerald-400 font-semibold">{formatBRL(s.amount)}</span>
                </Row>
              ))}
            </DetailList>

            <DetailList title={`Movimentações (${detail.movements.length})`}>
              {detail.movements.length === 0 && <Empty text="Sem sangrias ou suprimentos." />}
              {detail.movements.map((m) => (
                <Row
                  key={m.id}
                  title={m.type === "sangria" ? (m.refOrderLabel ? `Sangria (estorno ${m.refOrderLabel})` : "Sangria") : "Suprimento"}
                  sub={[m.note, m.createdByName && `${m.createdByName}`].filter(Boolean).join(" · ") || undefined}
                >
                  <span className={`font-semibold ${m.type === "sangria" ? "text-red-400" : "text-emerald-400"}`}>
                    {m.type === "sangria" ? "−" : "+"} {formatBRL(m.amount)}
                  </span>
                </Row>
              ))}
            </DetailList>
          </>
        )}
      </div>
    </Modal>
  );
}

function MiniStat({ label, value, className }) {
  return (
    <div className="bg-stone-950 border border-stone-800 rounded-xl p-3 text-center">
      <div className="text-stone-500 text-[11px] mb-1">{label}</div>
      <div className={`font-display font-bold text-sm ${className}`}>{value}</div>
    </div>
  );
}

function DetailList({ title, children }) {
  return (
    <div className="mb-4">
      <div className="text-stone-500 text-[11px] font-bold uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ title, sub, children }) {
  return (
    <div className="flex items-center justify-between text-sm bg-stone-950 border border-stone-800 rounded-xl px-3 py-2">
      <div>
        <div className="font-medium">{title}</div>
        {sub && <div className="text-stone-500 text-xs">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div className="text-stone-600 text-sm py-3 text-center">{text}</div>;
}