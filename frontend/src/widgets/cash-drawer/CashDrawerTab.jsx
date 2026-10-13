import React, { useState, useCallback, useEffect } from "react";
import { Wallet, Lock, History, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { getCurrentCashDrawer, listCashDrawers, openCashDrawer, registerCashMovement, closeCashDrawer } from "@/entities/cash";
import { EmptyState, PageHeader, Section } from "@/shared/components";
import { useRealtime } from "@/shared/hooks";
import { useAuth } from "@/app/providers/auth";
import { toDate } from "@/shared/lib";
import OpenCashDrawerModal from "./OpenCashDrawerModal.jsx";
import CashMovementModal from "./CashMovementModal.jsx";
import CloseCashDrawerModal from "./CloseCashDrawerModal.jsx";
import CashDrawerDetailModal from "./CashDrawerDetailModal.jsx";
import PrintReceipt from "./PrintReceipt.jsx";
import { formatBRL } from "@/shared/lib";


// "há 3h 12min" para a sessão aberta.
function fmtElapsed(iso, now) {
  const ms = Math.max(0, now - Date.parse(iso));
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

const PAGE = 20;

// Mapeia valores do backend para labels amigáveis
const CATEGORY_LABELS = {
  sangria_operacional: "Sangria operacional",
  suprimento_troco: "Suprimento para troco",
  pagamento_fornecedor: "Pagamento a fornecedor",
  ajuste_inventario: "Ajuste de inventário",
  outros: "Outros",
};

export default function CashDrawerTab({ showToast }) {
  const { session } = useAuth();
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openModal, setOpenModal] = useState(false);
  const [movementType, setMovementType] = useState(null);
  const [closeModal, setCloseModal] = useState(false);
  const [detail, setDetail] = useState(null);
  const [printId, setPrintId] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [now, setNow] = useState(Date.now());

  const reload = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([getCurrentCashDrawer(), listCashDrawers({ limit: PAGE })]);
      setCurrent(c);
      setHistory(h.data);
      setHasMore(h.data.length === PAGE);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Atualiza o "aberta há" a cada minuto pra sessão aberta.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Refresca ao vivo quando outro terminal altera o caixa (pagamentos em
  // dinheiro também são broadcast para o room "cash-drawer").
  useRealtime(session?.token, ["cash-drawer"], () => reload(), reload);

  async function loadMore() {
    try {
      const h = await listCashDrawers({ limit: PAGE, offset: history.length });
      setHistory((prev) => [...prev, ...h.data]);
      setHasMore(h.data.length === PAGE);
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleClose(payload) {
    try {
      const body = {
        countedAmount: payload.countedValue,
        note: payload.note,
        denominations: payload.denominations,
        justification: payload.justification,
        approvedBy: payload.approvedByPin, // TODO: backend deve validar PIN e retornar userId
      };
      const drawer = await closeCashDrawer(body);
      await reload();
      showToast("Caixa fechado.", "success");
      setPrintId(drawer.id);
      return true;
    } catch (e) {
      showToast(e.message, "error");
      return false;
    }
  }

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
    return <div className="text-text-muted text-center py-10">Carregando…</div>;
  }

  const open = current !== null;

  return (
    <div className="mx-auto max-w-xl space-y-5 p-4 sm:p-5">
      <PageHeader title="Caixa" description="Acompanhe a sessão ativa e o histórico de fechamentos." />
      {/* Status do caixa */}
      <div className="ui-surface p-5">
        <div className="flex items-center gap-2 text-text-secondary text-xs font-bold uppercase tracking-wide mb-1">
          <Wallet size={14} />
          {open ? "Caixa aberto" : "Caixa fechado"}
        </div>
        {open ? (
          <>
            <div className="text-text-muted text-xs mb-3">
              Aberto por {current.openedByName ?? "—"} às {toDate(current.openedAt)?.toLocaleTimeString() ?? "—"}
              <span className="text-text-muted"> · aberto há {fmtElapsed(current.openedAt, now)}</span>
            </div>
            <div className="text-3xl font-display font-bold text-success">{formatBRL(current.expectedCash)}</div>
            <div className="text-text-muted text-xs mt-1">esperado na gaveta</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-text-secondary">
              <span>Fundo: <b className="text-text-secondary">{formatBRL(current.openingAmount)}</b></span>
              <span>Vendas em dinheiro: <b className="text-text-secondary">{formatBRL(current.cashSalesTotal)}</b> ({current.cashSalesCount})</span>
            </div>
            <div className="flex gap-2 mt-5">
              <ActionButton onClick={() => setMovementType("sangria")} icon={ArrowDownCircle} label="Sangria" />
              <ActionButton onClick={() => setMovementType("suprimento")} icon={ArrowUpCircle} label="Suprimento" accent />
              <ActionButton onClick={() => setCloseModal(true)} icon={Lock} label="Fechar caixa" />
            </div>
          </>
        ) : (
          <>
            <div className="text-text-secondary text-sm mb-4">Nenhum caixa aberto no momento.</div>
            <button
              onClick={() => setOpenModal(true)}
              className="w-full bg-primary hover:bg-primary-strong text-primary-foreground font-semibold py-3 rounded-xl"
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
            <div className="text-text-muted text-sm py-4 text-center">Nenhuma sangria ou suprimento.</div>
          )}
          <div className="space-y-1.5">
            {current.movements.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm bg-surface border border-border rounded-xl px-3 py-2">
                <div>
                  <span className={`font-semibold ${m.type === "sangria" ? "text-destructive" : "text-success"}`}>
                    {m.type === "sangria" ? "Sangria" : "Suprimento"}
                  </span>
                  {m.category && (
                    <span className="inline-block text-[10px] font-medium bg-surface-overlay text-text-secondary rounded-full px-1.5 py-0.5 ml-1.5">
                      {CATEGORY_LABELS[m.category] || m.category}
                    </span>
                  )}
                  {m.refOrderLabel && (
                    <span className="inline-block text-[10px] font-semibold bg-surface-overlay text-primary rounded-full px-1.5 py-0.5 ml-1.5">
                      Estorno · {m.refOrderLabel}
                    </span>
                  )}
                  {m.note && <span className="text-text-muted text-xs ml-2">{m.note}</span>}
                  <div className="text-text-muted text-xs">
                    {toDate(m.createdAt)?.toLocaleTimeString() ?? "—"} · {m.createdByName ?? m.createdBy}
                  </div>
                </div>
                <span className={`font-semibold ${m.type === "sangria" ? "text-destructive" : "text-success"}`}>
                  {m.type === "sangria" ? "−" : "+"} {formatBRL(m.amount)}
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
              className="w-full flex items-center justify-between text-sm bg-surface border border-border rounded-xl px-3 py-2 hover:border-border text-left"
            >
              <div>
                <div className="flex items-center gap-1.5 font-medium">
                  <History size={13} className="text-text-muted" />
                  {toDate(d.openedAt)?.toLocaleString() ?? "—"}
                </div>
                <div className="text-text-muted text-xs">
                  fechado {toDate(d.closedAt)?.toLocaleString() ?? "—"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">
                  {d.closingDifference === 0 ? (
                    <span className="text-success">OK</span>
                  ) : (
                    <span className={d.closingDifference > 0 ? "text-success" : "text-destructive"}>
                      {d.closingDifference > 0 ? "+" : ""}{formatBRL(d.closingDifference)}
                    </span>
                  )}
                </div>
                <div className="text-text-muted text-xs">esperado {formatBRL(d.closingExpected)}</div>
              </div>
            </button>
          ))}
          {history.length === 0 && (
            <EmptyState
              icon={History}
              title="Nenhum caixa fechado ainda"
              description="Os fechamentos anteriores aparecerão aqui."
              compact
            />
          )}
        </div>
        {hasMore && (
          <button onClick={loadMore} className="w-full text-sm text-primary hover:text-primary font-medium py-2 mt-1">
            Carregar mais
          </button>
        )}
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
          expected={current?.expectedCash}
          onClose={() => setMovementType(null)}
          onConfirm={async (p) => {
            try {
              await registerCashMovement(movementType, p);
              await reload();
              showToast(movementType === "sangria" ? "Sangria registrada." : "Suprimento registrado.", "success");
              return true;
            } catch (e) {
              showToast(e.message, "error");
              throw e; // Relança para o modal capturar o erro específico
            }
          }}
        />
      )}
      {closeModal && current && (
        <CloseCashDrawerModal
          expected={current.expectedCash}
          onClose={() => setCloseModal(false)}
          onConfirm={handleClose}
        />
      )}
      {detail && <CashDrawerDetailModal drawerId={detail.id} onClose={() => setDetail(null)} showToast={showToast} onPrint={() => setPrintId(detail.id)} />}
      {printId && <PrintReceipt drawerId={printId} onDone={() => setPrintId(null)} />}
    </div>
  );
}

function ActionButton({ onClick, icon: Icon, label, accent }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl border ${
        accent
          ? "bg-surface-overlay hover:bg-surface-overlay border-border text-success"
          : "bg-surface-overlay hover:bg-surface-overlay border-border text-destructive"
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  );
}
