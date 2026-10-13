import Card from "./Card.jsx";

const meta = {
  title: "Design System/Primitives/Card",
  component: Card,
  tags: ["autodocs"],
  args: { tone: "default", padding: "md" },
  argTypes: {
    tone: {
      control: "inline-radio",
      options: ["default", "raised", "emphasized", "flat"],
    },
    padding: { control: "inline-radio", options: ["none", "sm", "md", "lg"] },
  },
};

export default meta;
export const Playground = {
  render: (args) => (
    <Card {...args} className="w-80">
      <p className="text-sm font-semibold">Comanda #1042</p>
      <p className="mt-1 text-sm text-text-secondary">Mesa 8 · 3 itens · R$ 86,50</p>
    </Card>
  ),
};

export const Tons = {
  render: () => (
    <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
      <Card><p className="font-semibold">Superfície padrão</p><p className="mt-1 text-sm text-text-secondary">Conteúdo principal.</p></Card>
      <Card tone="raised"><p className="font-semibold">Superfície elevada</p><p className="mt-1 text-sm text-text-secondary">Conteúdo secundário.</p></Card>
      <Card tone="emphasized"><p className="font-semibold">Destaque</p><p className="mt-1 text-sm text-text-secondary">Ação ou informação relevante.</p></Card>
      <Card tone="flat"><p className="font-semibold">Plano</p><p className="mt-1 text-sm text-text-secondary">Sem preenchimento destacado.</p></Card>
    </div>
  ),
};
