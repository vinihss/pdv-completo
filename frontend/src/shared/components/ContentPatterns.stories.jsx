import { Search } from "lucide-react";
import Button from "./Button.jsx";
import EmptyState from "./EmptyState.jsx";
import PageHeader from "./PageHeader.jsx";

const meta = {
  title: "Design System/Patterns/Content",
  component: PageHeader,
  tags: ["autodocs"],
};

export default meta;

export const CabecalhoDePagina = {
  render: () => (
    <div className="w-full max-w-3xl">
      <PageHeader
        title="Produtos"
        description="Gerencie os itens disponíveis no cardápio da sua loja."
        actions={<Button>Adicionar produto</Button>}
      />
    </div>
  ),
};

export const EstadoVazio = {
  render: () => (
    <div className="w-full max-w-xl">
      <EmptyState
        icon={Search}
        title="Nenhum produto encontrado"
        description="Revise os termos da busca ou cadastre um novo produto."
        action={<Button variant="secondary">Limpar busca</Button>}
      />
    </div>
  ),
};
