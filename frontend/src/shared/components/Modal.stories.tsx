import { useState } from "react";
import Button from "./Button.jsx";
import Input from "./Input.jsx";
import Modal from "./Modal.jsx";

const meta = {
  title: "Design System/Overlays/Modal",
  component: Modal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;

function ModalExample() {
  const [open, setOpen] = useState(true);

  return (
    <div className="min-h-screen bg-background p-6">
      <Button onClick={() => setOpen(true)}>Abrir edição de produto</Button>
      {open && (
        <Modal
          title="Editar produto"
          subtitle="Atualize as informações do cardápio"
          onClose={() => setOpen(false)}
          footer={
            <div className="mx-auto flex w-full max-w-2xl justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={() => setOpen(false)}>Salvar produto</Button>
            </div>
          }
        >
          <div className="mx-auto grid w-full max-w-2xl gap-5 p-5">
            <label className="grid gap-1.5 text-sm font-medium">
              Nome
              <Input defaultValue="Hambúrguer da casa" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Descrição
              <Input defaultValue="Pão, carne, queijo e salada" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Preço
              <Input inputMode="decimal" defaultValue="32,90" />
            </label>
            <p className="text-sm text-text-secondary">
              No celular, o modal ocupa a tela para preservar espaço de trabalho e manter as ações
              acessíveis.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export const EdicaoDeProduto = { render: () => <ModalExample /> };
