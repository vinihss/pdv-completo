import Badge from "./Badge.jsx";

const meta = {
  title: "Design System/Primitives/Badge",
  component: Badge,
  tags: ["autodocs"],
  args: { children: "Em preparo", tone: "warning" },
  argTypes: {
    tone: {
      control: "inline-radio",
      options: ["default", "primary", "success", "warning", "danger", "muted"],
    },
  },
};

export default meta;
export const Playground = {};

export const Tons = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone="default">Aberto</Badge>
      <Badge tone="primary">Novo</Badge>
      <Badge tone="success">Pronto</Badge>
      <Badge tone="warning">Atenção</Badge>
      <Badge tone="danger">Atrasado</Badge>
      <Badge tone="muted">Arquivado</Badge>
    </div>
  ),
};
