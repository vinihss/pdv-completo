import { useState } from "react";
import { Filter, Menu, X } from "lucide-react";
import Button from "./Button.jsx";
import Drawer from "./Drawer.jsx";

const meta = {
  title: "Design System/Overlays/Drawer",
  component: Drawer,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { side: "left" },
  argTypes: { side: { control: "inline-radio", options: ["left", "right"] } },
};

export default meta;

function DrawerExample({ side = "left" }) {
  const [open, setOpen] = useState(true);
  const isMenu = side === "left";

  return (
    <div className="min-h-screen bg-background p-6">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {isMenu ? <Menu size={16} /> : <Filter size={16} />}
        {isMenu ? "Abrir menu" : "Abrir filtros"}
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} side={side} label={isMenu ? "Menu da loja" : "Filtros de pedidos"} panelClassName="w-[min(20rem,85vw)] border-r p-5">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold">{isMenu ? "Navegação" : "Filtrar pedidos"}</h2>
          <button type="button" aria-label="Fechar painel" onClick={() => setOpen(false)} className="rounded-full p-2 text-text-secondary hover:bg-surface-overlay"><X size={18} /></button>
        </div>
        {isMenu ? (
          <nav aria-label="Navegação de exemplo" className="grid gap-2 text-sm">
            <a href="#comandas" className="rounded-lg bg-surface-overlay p-3 font-semibold">Comandas</a>
            <a href="#caixa" className="rounded-lg p-3 hover:bg-surface-overlay">Caixa</a>
            <a href="#estoque" className="rounded-lg p-3 hover:bg-surface-overlay">Estoque</a>
          </nav>
        ) : (
          <div className="grid gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" defaultChecked /> Em andamento</label>
            <label className="flex items-center gap-2"><input type="checkbox" /> Aguardando retirada</label>
            <Button onClick={() => setOpen(false)}>Aplicar filtros</Button>
          </div>
        )}
      </Drawer>
    </div>
  );
}

export const MenuLateral = { render: () => <DrawerExample side="left" /> };
export const Filtros = { render: (args) => <DrawerExample {...args} side="right" /> };
