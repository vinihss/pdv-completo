import { useState } from "react";
import Button from "./Button.jsx";
import { Toast } from "./Toast.jsx";

const meta = {
  title: "Design System/Patterns/Toast",
  component: Toast,
  tags: ["autodocs"],
  args: { toast: { msg: "Pedido salvo com sucesso.", kind: "success" } },
  argTypes: {
    toast: { control: "object" },
  },
};

export default meta;

export const Playground = {};

function ToastActionsExample() {
  const [toast, setToast] = useState(null);
  const show = (kind, msg) => setToast({ kind, msg });

  return (
    <div className="relative grid min-h-48 w-full max-w-xl content-start gap-4 rounded-2xl border border-border bg-surface p-6">
      <p className="text-sm text-text-secondary">Dispare uma notificação de exemplo:</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => show("info", "Pedido enviado para a cozinha.")}>Informação</Button>
        <Button variant="secondary" onClick={() => show("success", "Pagamento registrado.")}>Sucesso</Button>
        <Button variant="danger" onClick={() => show("error", "Não foi possível salvar as alterações.")}>Erro</Button>
      </div>
      {toast && <Toast toast={toast} />}
    </div>
  );
}

export const DispararFeedback = { render: () => <ToastActionsExample /> };

export const Informacao = { args: { toast: { msg: "Pedido enviado para a cozinha.", kind: "info" } } };
export const Sucesso = { args: { toast: { msg: "Pagamento registrado.", kind: "success" } } };
export const Erro = { args: { toast: { msg: "Não foi possível salvar as alterações.", kind: "error" } } };
