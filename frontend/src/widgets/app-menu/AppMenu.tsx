import { useAuth } from "@/app/providers/auth";
import {
  allItems,
  firstItemId,
  hasExpandableSections,
  useMenuSections,
  useNav,
} from "@/app/providers/nav";
import { useLowStockCount } from "@/entities/stock";
import { AccordionMenu, Drawer, UserAvatar } from "@/shared/components";
import { LogOut } from "lucide-react";
import React, { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

const ROLE_LABEL = {
  waiter: "Garçom",
  kitchen: "Cozinha",
  manager: "Gerente",
  cashier: "Caixa",
  courier: "Entregador",
};

/**
 * Menu principal do app: seções e submenus sempre visíveis, entrando pela esquerda.
 *
 * Desktop (`lg`+) é uma coluna de largura fixa ao lado do conteúdo — 18rem
 * para quem tem o que expandir (o gerente) e um trilho de 4rem para os perfis
 * de tela única, que não podem perder 288px de largura para um menu com um
 * item só. No celular é um painel de tela cheia, aberto pelo botão do header.
 *
 * As duas instâncias (coluna e painel) compartilham o estado de navegação,
 * senão girar o tablet perderia a tela ativa.
 */
export default function AppMenu() {
  const { session } = useAuth();
  const { activeId, setActiveId, drawerOpen, closeDrawer } = useNav();
  const lowCount = useLowStockCount();

  const sections = useMenuSections();

  const totalItems = useMemo(() => sections.flatMap((s) => s.items).length, [sections]);

  const variant = hasExpandableSections(sections) ? "full" : "rail";

  // Tela guardada que não existe mais (item removido, toggle desligado, troca
  // de papel): cai no primeiro item em vez de deixar a página em branco.
  // `!activeId` conta como "não existe": na primeira visita não há nada
  // guardado, e sem semear aqui o `activeId` ficaria nulo.
  useEffect(() => {
    const ids = new Set(allItems(sections).map((i) => i.id));
    if (!activeId || !ids.has(activeId)) {
      const fallback = firstItemId(sections);
      if (fallback) setActiveId(fallback);
    }
  }, [activeId, sections, setActiveId]);

  const withBadges = useMemo(
    () =>
      sections.map((s) => ({
        ...s,
        items: s.items.map((i) =>
          i.id === "stock" && lowCount > 0 ? { ...i, badge: lowCount } : i
        ),
      })),
    [sections, lowCount]
  );

  const menu = (footer) => (
    <AccordionMenu
      sections={withBadges}
      activeId={activeId}
      onSelect={setActiveId}
      variant={variant}
      footer={footer}
    />
  );

  // Mesma identidade na coluna do desktop e no painel do celular.
  const identity = (
    <Identity
      name={session?.user?.name}
      role={session?.user?.role}
      photoPath={session?.user?.photoPath}
    />
  );

  if (totalItems === 1) return null;

  return (
    <>
      <aside
        className={`hidden lg:flex shrink-0 flex-col sticky top-14 h-[calc(100vh-3.5rem)] border-r border-sidebar-border bg-sidebar text-sidebar-foreground ${
          variant === "rail" ? "w-16" : "w-72"
        }`}
      >
        <div className="flex-1 overflow-y-auto">{menu()}</div>
        {variant === "full" && (
          <div className="shrink-0 border-t border-sidebar-border p-3">{identity}</div>
        )}
      </aside>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        panelId="app-menu-painel"
        label="Menu principal"
        panelClassName="w-full border-r bg-sidebar text-sidebar-foreground"
      >
        <div className="flex-1 overflow-y-auto">{menu()}</div>
        {/* Identidade + logout: o scrim do painel é `fixed inset-0 z-50` e cobre
            o header (`z-40`), então no celular o "Sair" do rodapé é alcançado
            com o painel aberto. */}
        <div className="shrink-0 border-t border-sidebar-border p-3">{identity}</div>
      </Drawer>
    </>
  );
}

function Identity({ name, role, photoPath }) {
  const navigate = useNavigate();
  const { logout } = useAuth();

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <button
        type="button"
        onClick={() => navigate("/manager/profile")}
        className="shrink-0 rounded-full hover:ring-2 hover:ring-sidebar-primary transition-shadow"
        title="Meu perfil"
        aria-label="Meu perfil"
      >
        <UserAvatar name={name} photoPath={photoPath} className="w-8 h-8 text-[11px]" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-sidebar-foreground truncate">{name ?? "—"}</p>
        <p className="text-[11px] text-sidebar-foreground/60 truncate">
          {ROLE_LABEL[role] ?? role}
        </p>
      </div>
      <button
        type="button"
        onClick={logout}
        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent transition-colors"
        title="Sair"
        aria-label="Sair"
      >
        <LogOut size={16} />
      </button>
    </div>
  );
}
