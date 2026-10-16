import { MoreHorizontal } from "lucide-react";
import Button from "./Button.jsx";
import ScreenHeader from "./ScreenHeader.jsx";

const meta = {
  title: "Design System/Patterns/ScreenHeader",
  component: ScreenHeader,
  tags: ["autodocs"],
  args: { title: "Lançar itens", subtitle: "Comanda #1042 · Mesa 8" },
  argTypes: {
    title: { control: "text" },
    subtitle: { control: "text" },
    backIcon: { control: "inline-radio", options: ["chevron", "close"] },
  },
};

export default meta;

export const NavegacaoDeFluxo = {
  render: (args) => (
    <div className="w-full max-w-2xl border border-border bg-background">
      <ScreenHeader
        {...args}
        onBack={() => {}}
        right={
          <Button variant="ghost" size="sm" aria-label="Mais opções">
            <MoreHorizontal size={20} />
          </Button>
        }
      />
      <div className="p-5 text-sm text-text-secondary">
        Conteúdo da tela de fluxo. O cabeçalho permanece no topo enquanto o usuário edita a comanda.
      </div>
    </div>
  ),
};

export const SemNavegacaoDeVolta = {
  args: { title: "Cozinha", subtitle: "Estação quente", backIcon: "chevron" },
  render: (args) => (
    <div className="w-full max-w-2xl border border-border bg-background">
      <ScreenHeader {...args} />
      <p className="p-5 text-sm text-text-secondary">
        Cabeçalho para uma tela sem ação de retorno.
      </p>
    </div>
  ),
};
