import React, { useState, useCallback, useEffect } from "react";
import { Wallet, Lock, History, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { getCurrentCashDrawer, listCashDrawers, openCashDrawer, registerCashMovement, closeCashDrawer } from "@/shared/api/cash";
import { Section } from "@/shared/components";
import { useRealtime } from "@/shared/hooks";
import { useAuth } from "@/features/auth";
import { toDate } from "@/shared/lib";
import OpenCashDrawerModal from "./OpenCashDrawerModal.jsx";
import CashMovementModal from "./CashMovementModal.jsx";
import CloseCashDrawerModal from "./CloseCashDrawerModal.jsx";
import CashDrawerDetailModal from "./CashDrawerDetailModal.jsx";

const fmt = (n) => `R$ ${Number(n || 0).toFixed(2)}`;

export default function CashDrawerTab({ showToast }) {
  const { session } = useAuth();
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openModal, setOpenModal] = useState(false);
  const [movementType, setMovementType] = useState(null);
  const [closeModal, setCloseModal] = useState(false);
  const [detail, setDetail] = useState(null);

  const reload = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([getCurrentCashDrawer(), listCashDrawers({ limit: 20 })]);
      setCurrent(c);
      setHistory(h.data);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Refresca ao vivo quando outro terminal altera o caixa (pagamentos em
  // dinheiro também são broadcast para o room "cash-drawer").
  useRealtime(session?.token, ["cash-drawer"], () => reload());

  async function run(action, successMsg) {
    try {
      await action();
      await reload();
      showToast(successMsg, "success");
      return true;
    } catch (e) {
      showToast(e.message, "error");
      return false;
    }
  }

  if (loading) {
    return <div className="text-stone-600 text-center py-10">Carregando…</div>;
  }

  const open = current !== null;

  return (
    <div className="p-5 max-w-xl mx-auto space-y-5">
      {/* Status do caixa */}
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5">
        <div className="flex items-center gap-2 text-stone-400 text-xs font-bold uppercase tracking-wide mb-1">
          <Wallet size={14} />
          {open ? "Caixa aberto" : "Caixa fechado"}
        </div>
        {open ? (
          <>
            <div className="text-stone-500 text-xs mb-3">
              Aberto por {current.openedByName ?? "—"} às {toDate(current.openedAt).toLocaleTimeString()}
            </div>
            <div className="text-3xl font-display font-bold text-emerald-400">{fmt(current.expectedCash)}</div>
            <div className="text-stone-500 text-xs mt-1">esperado na gaveta</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-stone-400">
              <span>Fundo: <b className="text-stone-200">{fmt(current.openingAmount)}</b></span>
              <span>Vendas em dinheiro: <b className="text-stone-200">{fmt(current.cashSalesTotal)}</b> ({current.cashSalesCount})</span>
            </div>
            <div className="flex gap-2 mt-5">
              <ActionButton onClick={() => setMovementType("sangria")} icon={ArrowDownCircle} label="Sangria" />
              <ActionButton onClick={() => setMovementType("suprimento")} icon={ArrowUpCircle} label="Suprimento" accent />
              <ActionButton onClick={() => setCloseModal(true)} icon={Lock} label="Fechar caixa" />
            </div>
          </>
        ) : (
          <>
            <div className="text-stone-400 text-sm mb-4">Nenhum caixa aberto no momento.</div>
            <button
              onClick={() => setOpenModal(true)}
              className="w-full bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 rounded-xl"
            >
              Abrir caixa
            </button>
          </>
        )}
      </div>

      {/* Movimentações da sessão atual */}
      {open && (
        <Section title="Movimentações">
          {current.movements.length === 0 && (
            <div className="text-stone-600 text-sm py-4 text-center">Nenhuma sangria ou suprimento.</div>
          )}
          <div className="space-y-1.5">
            {current.movements.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm bg-stone-900 border border-stone-800 rounded-xl px-3 py-2">
                <div>
                  <span className={`font-semibold ${m.type === "sangria" ? "text-red-400" : "text-emerald-400"}`}>
                    {m.type === "sangria" ? "Sangria" : "Suprimento"}
                  </span>
                  {m.note && <span className="text-stone-500 text-xs ml-2">{m.note}</span>}
                  <div className="text-stone-600 text-xs">
                    {toDate(m.createdAt).toLocaleTimeString()} · {m.createdByName ?? m.createdBy}
                  </div>
                </div>
                <span className={`font-semibold ${m.type === "sangria" ? "text-red-400" : "text-emerald-400"}`}>
                  {m.type === "sangria" ? "−" : "+"} {fmt(m.amount)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Histórico de caixas fechados */}
      <Section title={`Histórico (${history.length})`}>
        <div className="space-y-1.5">
          {history.map((d) => (
            <button
              key={d.id}
              onClick={() => setDetail(d)}
              className="w-full flex items-center justify-between text-sm bg-stone-900 border border-stone-800 rounded-xl px-3 py-2 hover:border-stone-700 text-left"
            >
              <div>
                <div className="flex items-center gap-1.5 font-medium">
                  <History size={13} className="text-stone-500" />
                  {toDate(d.openedAt).toLocaleString()}
                </div>
                <div className="text-stone-500 text-xs">
                  fechado {d.closedAt ? toDate(d.closedAt).toLocaleString() : "—"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">
                  {d.closingDifference === 0 ? (
                    <span className="text-emerald-400">OK</span>
                  ) : (
                    <span className={d.closingDifference > 0 ? "text-emerald-400" : "text-red-400"}>
                      {d.closingDifference > 0 ? "+" : ""}{fmt(d.closingDifference)}
                    </span>
                  )}
                </div>
                <div className="text-stone-500 text-xs">esperado {fmt(d.closingExpected)}</div>
              </div>
            </button>
          ))}
          {history.length === 0 && <div className="text-stone-600 text-sm py-4 text-center">Nenhum caixa fechado ainda.</div>}
        </div>
      </Section>

      {/* Modais */}
      {openModal && (
        <OpenCashDrawerModal
          onClose={() => setOpenModal(false)}
          onConfirm={(p) => run(() => openCashDrawer(p), "Caixa aberto.")}
        />
      )}
      {movementType && (
        <CashMovementModal
          type={movementType}
          onClose={() => setMovementType(null)}
          onConfirm={(p) => run(() => registerCashMovement(movementType, p), movementType === "sangria" ? "Sangria registrada." : "Suprimento registrado.")}
        />
      )}
      {closeModal && current && (
        <CloseCashDrawerModal
          expected={current.expectedCash}
          onClose={() => setCloseModal(false)}
          onConfirm={(counted) => run(() => closeCashDrawer(counted), "Caixa fechado.")}
        />
      )}
      {detail && <CashDrawerDetailModal drawerId={detail.id} onClose={() => setDetail(null)} showToast={showToast} />}
    </div>
  );
}

function ActionButton({ onClick, icon: Icon, label, accent }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl border ${
        accent
          ? "bg-stone-800 hover:bg-stone-750 border-stone-700 text-emerald-400"
          : "bg-stone-800 hover:bg-stone-750 border-stone-700 text-red-400"
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  );
}