import Input, { Textarea } from "./Input.jsx";

const meta = {
  title: "Design System/Primitives/Fields",
  component: Input,
  tags: ["autodocs"],
  args: { placeholder: "Ex.: Refrigerante lata", "aria-label": "Nome do produto" },
  argTypes: { invalid: { control: "boolean" } },
};

export default meta;
export const Playground = {};

export const Estados = {
  render: () => (
    <div className="grid w-80 gap-4">
      <label className="grid gap-1.5 text-sm font-medium">Nome do produto<Input placeholder="Ex.: Refrigerante lata" /></label>
      <label className="grid gap-1.5 text-sm font-medium">Preço<Input inputMode="decimal" defaultValue="8,50" /></label>
      <label className="grid gap-1.5 text-sm font-medium">Campo inválido<Input invalid aria-invalid="true" defaultValue="" placeholder="Informe um valor" /></label>
      <label className="grid gap-1.5 text-sm font-medium">Desabilitado<Input disabled defaultValue="Somente leitura" /></label>
      <label className="grid gap-1.5 text-sm font-medium">Observações<Textarea placeholder="Observações do pedido" /></label>
    </div>
  ),
};
