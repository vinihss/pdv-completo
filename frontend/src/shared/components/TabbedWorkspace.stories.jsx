import React, { useState } from "react";
import { formatBRL } from "@/shared/lib";
import TabbedWorkspace from "./TabbedWorkspace.jsx";

const meta = {
  title: "Design System/Padrões/Tela com subabas",
  component: TabbedWorkspace,
  parameters: { layout: "fullscreen" },
};

export default meta;

const tabs = [
  { id: "items", label: "Itens", count: 18 },
  { id: "groups", label: "Categorias e grupos", count: 5 },
  { id: "availability", label: "Disponibilidade" },
];

function ExampleWorkspace() {
  const [activeTab, setActiveTab] = useState("items");
  const content = {
    items: (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {["Café espresso", "Cappuccino", "Pão de queijo"].map((item, index) => (
          <article key={item} className="rounded-2xl border border-border bg-surface p-5">
            <p className="text-xs font-semibold text-text-muted">Produto {index + 1}</p>
            <h2 className="mt-2 text-lg font-bold">{item}</h2>
            <p className="mt-1 text-sm text-text-secondary">{formatBRL(8 + index * 2)}</p>
          </article>
        ))}
      </div>
    ),
    groups: <div className="rounded-2xl border border-border bg-surface p-6 text-sm text-text-secondary">Organize produtos por categoria ou estação de produção.</div>,
    availability: <div className="rounded-2xl border border-border bg-surface p-6 text-sm text-text-secondary">Revise quais itens estão disponíveis para venda.</div>,
  };

  return (
    <TabbedWorkspace
      id="workspace-story"
      eyebrow="Padrão de interface"
      title="Catálogo de produtos"
      description="Uma tela ampla com áreas relacionadas organizadas em subabas. A navegação também aceita as setas do teclado."
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      actions={<button type="button" className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">Novo item</button>}
    >
      {content[activeTab]}
    </TabbedWorkspace>
  );
}

export const VisãoGeral = { render: () => <ExampleWorkspace /> };
