import React, { useState, useEffect } from "react";
import { Modal, Button, Field, inputClass } from "@/shared/components";
import { registerSettlement, CHANNELS, todayISO, calcPayoutAmount } from "@/entities/settlement";
import { listOrders } from "@/entities/order";
import { orderLabel } from "@/entities/order";
import { formatBRL } from "@/shared/lib";

export default function RegisterSettlementModal({ onClose, onSuccess, showToast }) {
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [orderId, setOrderId] = useState("");
  const [channel, setChannel] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [commissionAmount, setCommissionAmount] = useState("");
  const [marketplaceFee, setMarketplaceFee] = useState("");
  const [deliveryFeeSubsidy, setDeliveryFeeSubsidy] = useState("");
  const [payoutExpectedAt, setPayoutExpectedAt] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadOrders() {
      try {
        const closedOrders = await listOrders("closed", 100);
        setOrders(closedOrders);
      } catch {
        showToast("Erro ao carregar pedidos", "error");
      } finally {
        setLoadingOrders(false);
      }
    }
    loadOrders();
  }, [showToast]);

  const gross = parseFloat(grossAmount) || 0;
  const commission = parseFloat(commissionAmount) || 0;
  const marketplace = parseFloat(marketplaceFee) || 0;
  const deliverySubsidy = parseFloat(deliveryFeeSubsidy) || 0;
  const payoutAmount = calcPayoutAmount({
    grossAmount: gross,
    commissionAmount: commission,
    marketplaceFee: marketplace,
    deliveryFeeSubsidy: deliverySubsidy,
  });

  async function handleSubmit(e) {
    e.preventDefault();

    if (!orderId) {
      showToast("Selecione um pedido", "error");
      return;
    }
    if (!channel) {
      showToast("Selecione um canal", "error");
      return;
    }
    if (gross <= 0) {
      showToast("Valor bruto deve ser maior que zero", "error");
      return;
    }
    if (commission < 0) {
      showToast("Comissão não pode ser negativa", "error");
      return;
    }
    if (payoutAmount < 0) {
      showToast("Payout não pode ser negativo", "error");
      return;
    }

    setSubmitting(true);
    try {
      await registerSettlement({
        orderId,
        channel,
        grossAmount: gross,
        commissionAmount: commission,
        marketplaceFee: marketplace || undefined,
        deliveryFeeSubsidy: deliverySubsidy || undefined,
        payoutExpectedAt: payoutExpectedAt || undefined,
        externalRef: externalRef || undefined,
        notes: notes || undefined,
      });
      showToast("Settlement registrado com sucesso", "success");
      onSuccess?.();
      onClose();
    } catch (err) {
      showToast(err.message || "Erro ao registrar settlement", "error");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedOrder = orders.find((o) => o.id === orderId);

  return (
    <Modal
      title="Novo Settlement"
      onClose={onClose}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" form="register-settlement-form" disabled={submitting}>
            {submitting ? "Registrando..." : "Registrar"}
          </Button>
        </div>
      }
    >
      <form id="register-settlement-form" onSubmit={handleSubmit} className="p-4 space-y-4">
        <Field label="Pedido" required>
          {loadingOrders ? (
            <div className="text-stone-500 text-sm py-2">Carregando pedidos...</div>
          ) : (
            <select
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              className={inputClass}
              required
              disabled={loadingOrders || orders.length === 0}
            >
              <option value="">Selecione um pedido</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {orderLabel(o)} — {formatBRL(o.total)}
                </option>
              ))}
            </select>
          )}
        </Field>

        {selectedOrder && (
          <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-stone-400">Total do pedido:</span>
              <span className="font-medium">{formatBRL(selectedOrder.total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-400">Data fechamento:</span>
              <span className="font-medium">
                {new Date(selectedOrder.closedAt).toLocaleDateString("pt-BR")}
              </span>
            </div>
          </div>
        )}

        <Field label="Canal" required>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className={inputClass}
            required
          >
            <option value="">Selecione o canal</option>
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor bruto (R$)" required>
            <input
              type="number"
              step="0.01"
              min="0"
              value={grossAmount}
              onChange={(e) => setGrossAmount(e.target.value)}
              className={inputClass}
              required
              placeholder="0,00"
            />
          </Field>
          <Field label="Comissão (R$)" required>
            <input
              type="number"
              step="0.01"
              min="0"
              value={commissionAmount}
              onChange={(e) => setCommissionAmount(e.target.value)}
              className={inputClass}
              required
              placeholder="0,00"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Taxa marketplace (R$)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={marketplaceFee}
              onChange={(e) => setMarketplaceFee(e.target.value)}
              className={inputClass}
              placeholder="0,00"
            />
          </Field>
          <Field label="Subsídio entrega (R$)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={deliveryFeeSubsidy}
              onChange={(e) => setDeliveryFeeSubsidy(e.target.value)}
              className={inputClass}
              placeholder="0,00"
            />
          </Field>
        </div>

        <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-stone-400">Total de taxas:</span>
            <span className="font-medium">
              {formatBRL(commission + marketplace + deliverySubsidy)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">Payout líquido:</span>
            <span className="font-semibold text-emerald-400 text-lg">{formatBRL(payoutAmount)}</span>
          </div>
        </div>

        <Field label="Data esperada de recebimento">
          <input
            type="date"
            value={payoutExpectedAt}
            onChange={(e) => setPayoutExpectedAt(e.target.value)}
            className={inputClass}
            min={todayISO()}
          />
        </Field>

        <Field label="Referência externa">
          <input
            type="text"
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            className={inputClass}
            placeholder="ID do pagamento no marketplace"
          />
        </Field>

        <Field label="Observações">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputClass}
            rows="3"
            placeholder="Detalhes adicionais (opcional)"
          />
        </Field>
      </form>
    </Modal>
  );
}
