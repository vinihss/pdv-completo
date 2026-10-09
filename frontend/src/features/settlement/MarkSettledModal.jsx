import React, { useState } from "react";
import { Modal, Button } from "@/shared/components";
import { Field, inputClass } from "@/shared/components";
import { markSettled, formatDate } from "@/entities/settlement";
import { formatBRL } from "@/shared/lib";
import { todayISO } from "@/entities/settlement";

export default function MarkSettledModal({ settlement, onClose, onSuccess, showToast }) {
  const [payoutSettledAt, setPayoutSettledAt] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!payoutSettledAt) {
      showToast("Informe a data de recebimento", "error");
      return;
    }

    setSubmitting(true);
    try {
      await markSettled(settlement.id, payoutSettledAt);
      showToast("Settlement marcado como recebido", "success");
      onSuccess?.();
      onClose();
    } catch (err) {
      showToast(err.message || "Erro ao marcar settlement", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Confirmar recebimento"
      onClose={onClose}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" form="mark-settled-form" disabled={submitting}>
            {submitting ? "Confirmando..." : "Confirmar recebimento"}
          </Button>
        </div>
      }
    >
      <form id="mark-settled-form" onSubmit={handleSubmit} className="p-4 space-y-4">
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-stone-400">Pedido:</span>
            <span className="font-medium">{settlement.orderLabel || settlement.orderId}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">Payout:</span>
            <span className="font-medium text-emerald-400">{formatBRL(settlement.payoutAmount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">Data esperada:</span>
            <span className="font-medium">{formatDate(settlement.payoutExpectedAt)}</span>
          </div>
        </div>

        <Field label="Data efetiva de recebimento" required>
          <input
            type="date"
            value={payoutSettledAt}
            onChange={(e) => setPayoutSettledAt(e.target.value)}
            className={inputClass}
            required
            max={todayISO()}
          />
        </Field>
      </form>
    </Modal>
  );
}
