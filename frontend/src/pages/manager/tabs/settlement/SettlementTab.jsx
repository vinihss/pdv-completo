import React, { useState, useEffect, useCallback } from "react";
import { listSettlements, channelLabel, payoutStatusLabel, payoutStatusTone, formatDate, formatDateTime, sumSettlements } from "@/entities/settlement";
import { PERIOD_PRESETS, periodRange } from "@/entities/reports";
import { formatBRL } from "@/shared/lib";
import { RegisterSettlementModal, MarkSettledModal } from "@/features/settlement";
import { Section, Field, inputClass, Button, EmptyState, Spinner } from "@/shared/components";
import { Plus, CheckCircle, Clock, AlertCircle } from "lucide-react";

export default function SettlementTab({ showToast }) {
  const [settlements, setSettlements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [showMarkModal, setShowMarkModal] = useState(false);
  const [selectedSettlement, setSelectedSettlement] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters = {};
      if (channel) filters.channel = channel;
      if (status) filters.payout_status = status;
      if (dateFrom) filters.from = dateFrom;
      if (dateTo) filters.to = dateTo;
      const data = await listSettlements(filters);
      setSettlements(data);
    } catch (err) {
      showToast(err.message || "Erro ao carregar settlements", "error");
    } finally {
      setLoading(false);
    }
  }, [channel, status, dateFrom, dateTo, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  function pickPreset(id) {
    const r = periodRange(id);
    if (!r) return;
    setDateFrom(r.from);
    setDateTo(r.to);
  }

  function handleRegisterSuccess() {
    load();
  }

  function handleMarkSuccess() {
    load();
  }

  function openMarkModal(settlement) {
    setSelectedSettlement(settlement);
    setShowMarkModal(true);
  }

  const totals = sumSettlements(settlements);

  return (
    <div className="p-5 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Conciliação de Settlements</h1>
          <p className="text-stone-500 text-sm">Gerencie recebimentos de marketplaces</p>
        </div>
        <Button onClick={() => setShowRegisterModal(true)}>
          <Plus size={18} />
          Novo Settlement
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total bruto" value={formatBRL(totals.grossTotal)} />
        <StatCard label="Comissões e taxas" value={formatBRL(totals.commissionTotal + totals.feesTotal)} />
        <StatCard label="Payout pendente" value={formatBRL(totals.payoutPending)} tone="amber" />
        <StatCard label="Payout recebido" value={formatBRL(totals.payoutReceived)} tone="emerald" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p.id)}
            className="px-3 h-8 rounded-lg text-[13px] font-medium bg-stone-900 border border-stone-800 text-stone-400 hover:text-stone-100 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Canal">
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass}>
            <option value="">Todos</option>
            <option value="ifood">iFood</option>
            <option value="rappi">Rappi</option>
            <option value="uber_eats">Uber Eats</option>
            <option value="direct">Direto</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
            <option value="">Todos</option>
            <option value="pending">Pendente</option>
            <option value="paid">Recebido</option>
            <option value="failed">Falhou</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="De">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Até">
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
        </Field>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      )}

      {!loading && settlements.length === 0 && (
        <EmptyState
          icon={CheckCircle}
          title="Nenhum settlement encontrado"
          description="Ajuste os filtros ou registre um novo settlement."
        />
      )}

      {!loading && settlements.length > 0 && (
        <Section title={`Settlements (${settlements.length})`}>
          <div className="space-y-3">
            {settlements.map((s) => (
              <SettlementCard key={s.id} settlement={s} onMarkSettled={openMarkModal} />
            ))}
          </div>
        </Section>
      )}

      {showRegisterModal && (
        <RegisterSettlementModal
          onClose={() => setShowRegisterModal(false)}
          onSuccess={handleRegisterSuccess}
          showToast={showToast}
        />
      )}

      {showMarkModal && selectedSettlement && (
        <MarkSettledModal
          settlement={selectedSettlement}
          onClose={() => {
            setShowMarkModal(false);
            setSelectedSettlement(null);
          }}
          onSuccess={handleMarkSuccess}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, tone = "stone" }) {
  const toneClass = {
    stone: "text-stone-100",
    amber: "text-amber-400",
    emerald: "text-emerald-400",
  }[tone];

  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-3">
      <div className="text-stone-500 text-xs font-medium mb-1">{label}</div>
      <div className={`text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function SettlementCard({ settlement, onMarkSettled }) {
  const statusLabel = payoutStatusLabel(settlement.payoutStatus);
  const statusTone = payoutStatusTone(settlement.payoutStatus);
  const toneClass = {
    pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    paid: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    failed: "bg-red-500/15 text-red-400 border-red-500/30",
  }[statusTone];

  const statusIcon = {
    pending: Clock,
    paid: CheckCircle,
    failed: AlertCircle,
  }[statusTone];

  const Icon = statusIcon;

  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm truncate">
              {settlement.orderLabel || settlement.orderId}
            </span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${toneClass}`}>
              <Icon size={12} />
              {statusLabel}
            </span>
          </div>
          <div className="text-stone-500 text-xs">
            {channelLabel(settlement.channel)} · Criado em {formatDateTime(settlement.createdAt)}
          </div>
        </div>
        {settlement.payoutStatus === "pending" && (
          <Button size="sm" variant="primary" onClick={() => onMarkSettled(settlement)}>
            Marcar recebido
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-stone-500 text-xs mb-0.5">Valor bruto</div>
          <div className="font-medium">{formatBRL(settlement.grossAmount)}</div>
        </div>
        <div>
          <div className="text-stone-500 text-xs mb-0.5">Comissão</div>
          <div className="font-medium">{formatBRL(settlement.commissionAmount)}</div>
        </div>
        <div>
          <div className="text-stone-500 text-xs mb-0.5">Taxas</div>
          <div className="font-medium">
            {formatBRL((settlement.marketplaceFee || 0) + (settlement.deliveryFeeSubsidy || 0))}
          </div>
        </div>
        <div>
          <div className="text-stone-500 text-xs mb-0.5">Payout</div>
          <div className="font-bold text-emerald-400">{formatBRL(settlement.payoutAmount)}</div>
        </div>
      </div>

      {(settlement.payoutExpectedAt || settlement.payoutSettledAt) && (
        <div className="border-t border-stone-800 pt-2 text-xs text-stone-500 flex gap-4">
          {settlement.payoutExpectedAt && (
            <div>
              <span className="font-medium">Esperado:</span> {formatDate(settlement.payoutExpectedAt)}
            </div>
          )}
          {settlement.payoutSettledAt && (
            <div>
              <span className="font-medium">Recebido:</span> {formatDate(settlement.payoutSettledAt)}
            </div>
          )}
        </div>
      )}

      {settlement.externalRef && (
        <div className="text-xs text-stone-600">
          Ref: {settlement.externalRef}
        </div>
      )}
    </div>
  );
}
