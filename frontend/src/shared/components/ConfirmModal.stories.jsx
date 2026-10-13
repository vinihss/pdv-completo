import { useState } from "react";
import Button from "./Button.jsx";
import ConfirmModal from "./ConfirmModal.jsx";

const meta = {
  title: "Design System/Overlays/ConfirmModal",
  component: ConfirmModal,
  tags: ["autodocs"],
  args: {
    title: "Remover produto?",
    message: "O produto será removido do cardápio da loja.",
    confirmLabel: "Remover produto",
    destructive: true,
  },
  argTypes: {
    title: { control: "text" },
    message: { control: "text" },
    confirmLabel: { control: "text" },
    destructive: { control: "boolean" },
    onCancel: { control: false },
    onConfirm: { control: false },
  },
};

export default meta;

function ConfirmationExample({ destructive = true, title, message, confirmLabel }) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState("");

  return (
    <div className="min-h-64 min-w-80 p-6">
      <Button variant="secondary" onClick={() => { setResult(""); setOpen(true); }}>Abrir confirmação</Button>
      {result && <p className="mt-4 text-sm text-text-secondary" role="status">{result}</p>}
      {open && (
        <ConfirmModal
          title={title}
          message={message}
          confirmLabel={confirmLabel}
          destructive={destructive}
          onCancel={() => { setOpen(false); setResult("Ação cancelada."); }}
          onConfirm={() => { setOpen(false); setResult("Ação confirmada."); }}
        />
      )}
    </div>
  );
}

export const Destrutiva = {
  render: (args) => <ConfirmationExample {...args} />,
};

export const ConfirmacaoPadrao = {
  args: {
    title: "Marcar pedido como pronto?",
    message: "O cliente será avisado que o pedido está pronto para retirada.",
    confirmLabel: "Marcar como pronto",
    destructive: false,
  },
  render: (args) => <ConfirmationExample {...args} />,
};
