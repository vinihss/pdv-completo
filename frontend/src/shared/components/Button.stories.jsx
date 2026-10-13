import Button from "./Button.jsx";

const meta = {
  title: "Design System/Primitives/Button",
  component: Button,
  tags: ["autodocs"],
  args: {
    children: "Adicionar item",
    variant: "primary",
    size: "md",
    disabled: false,
  },
  argTypes: {
    variant: {
      control: "inline-radio",
      options: ["primary", "secondary", "danger", "ghost"],
    },
    size: {
      control: "inline-radio",
      options: ["sm", "md", "lg"],
    },
    type: { control: false },
  },
};

export default meta;

export const Playground = {};

export const Variantes = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Confirmar pedido</Button>
      <Button variant="secondary">Cancelar</Button>
      <Button variant="danger">Excluir comanda</Button>
      <Button variant="ghost">Ver detalhes</Button>
    </div>
  ),
};

export const Tamanhos = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">Pequeno</Button>
      <Button size="md">Padrão</Button>
      <Button size="lg">Grande</Button>
      <Button disabled>Indisponível</Button>
    </div>
  ),
};
