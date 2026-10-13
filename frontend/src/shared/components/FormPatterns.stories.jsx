import { useState } from "react";
import { Field, Section, ToggleRow } from "./Form.jsx";
import Input from "./Input.jsx";

const meta = {
  title: "Design System/Patterns/Formulários",
  component: Section,
  tags: ["autodocs"],
};

export default meta;

function FormSectionExample() {
  const [usesDelivery, setUsesDelivery] = useState(true);
  const [kitchenEnabled, setKitchenEnabled] = useState(false);

  return (
    <div className="w-full max-w-xl">
      <Section title="Configurações da loja">
        <Field label="Nome da loja" required>
          <Input defaultValue="Cheempa Restaurante" />
        </Field>
        <Field label="Telefone para pedidos">
          <Input type="tel" placeholder="(11) 99999-0000" />
        </Field>
        <ToggleRow label="Aceita entrega" checked={usesDelivery} onChange={setUsesDelivery} />
        <ToggleRow label="Exibir painel da cozinha" checked={kitchenEnabled} onChange={setKitchenEnabled} />
      </Section>
      <p className="mt-3 text-xs text-text-muted" aria-live="polite">
        Entrega {usesDelivery ? "ativada" : "desativada"} · Cozinha {kitchenEnabled ? "ativada" : "desativada"}
      </p>
    </div>
  );
}

export const ConfiguracoesDaLoja = {
  render: () => <FormSectionExample />,
};
