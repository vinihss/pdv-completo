import React, { useEffect, useMemo, useState } from "react";
import { AccordionMenu, Drawer, UserAvatar } from "@/shared/components";
import { useAuth } from "@/app/providers/auth";
import { useNav, hasExpandableSections, firstItemId, allItems, sectionOwning, useMenuSections } from "@/app/providers/nav";
import { useLowStockCount } from "@/entities/stock";

const ROLE_LABEL = {
  waiter: "Garçom",
  kitchen: "Cozinha",
  manager: "Gerente",
  cashier: "Caixa",
  courier: "Entregador",
};

/**
 * Menu principal do app: accordion de seções, entrando pela esquerda.
 *
 * Desktop (`lg`+) é uma coluna de largura fixa ao lado do conteúdo — 18rem
 * para quem tem o que expandir (o gerente) e um trilho de 4rem para os perfis
 * de tela única, que não podem perder 288px de largura para um menu com um
 * item só. No celular é um painel de tela cheia, aberto pelo botão do header.
 *
 * As duas instâncias (coluna e painel) compartilham o estado das seções, senão
 * girar o tablet perderia o que o usuário tinha aberto.
 *
 * Dois níveis de expansão, com estados separados de propósito: `expanded` são
 * as SEÇÕES ("Gestão"), `expandedItems` são os itens com submenu
 * ("Relatórios"). Um `Set` só não daria conta de abrir "Relatórios" sem fechar
 * "Gestão" ao mesmo tempo.
 */
export default function AppMenu() {
  const { session } = useAuth();
  const { activeId, setActiveId, drawerOpen, closeDrawer } = useNav();
  const lowCount = useLowStockCount();

  const sections = useMenuSections();

  const totalItems = useMemo(() => sections.flatMap((s) => s.items).length, [sections]);

  const variant = hasExpandableSections(sections) ? "full" : "rail";

  const [expanded, setExpanded] = useState(() => new Set());
  const [expandedItems, setExpandedItems] = useState(() => new Set());

  // A seção da tela ativa começa aberta; as outras o usuário abre quando quiser
  // (mais de uma aberta ao mesmo tempo: no desktop um 2º clique é caro).
  // `sectionOwning` (e não um `find` inline) porque o id pode ser de um
  // submenu: "reports.orders" mora na seção "Gestão".
  useEffect(() => {
    const owner = sectionOwning(sections, activeId);
    if (owner) setExpanded((prev) => (prev.has(owner.id) ? prev : new Set(prev).add(owner.id)));
  }, [activeId, sections]);

  // O submenu do item que dá a tela atual também abre junto: chegar em
  // "Relatórios › Pedidos" por um link antigo ou pelo foco de uma comanda não
  // pode deixar o usuário sem saber em qual relatório ele está.
  useEffect(() => {
    const parent = sections
      .flatMap((s) => s.items)
      .find((i) => i.children?.some((c) => c.id === activeId));
    if (parent) setExpandedItems((prev) => (prev.has(parent.id) ? prev : new Set(prev).add(parent.id)));
  }, [activeId, sections]);

  // Tela guardada que não existe mais (item removido, toggle desligado, troca
  // de papel): cai no primeiro item em vez de deixar a página em branco.
  // `!activeId` conta como "não existe": na primeira visita não há nada
  // guardado, e sem semear aqui o `activeId` ficaria nulo — nenhuma seção
  // abriria (o efeito de cima não acha dono de id que não existe) e a coluna
  // começaria toda recolhida.
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
        items: s.items.map((i) => (i.id === "stock" && lowCount > 0 ? { ...i, badge: lowCount } : i)),
      })),
    [sections, lowCount]
  );

  function toggleSection(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleItem(id) {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const menu = (footer) => (
    <AccordionMenu
      sections={withBadges}
      activeId={activeId}
      onSelect={setActiveId}
      variant={variant}
      expanded={expanded}
      onToggleSection={toggleSection}
      expandedItems={expandedItems}
      onToggleItem={toggleItem}
      footer={footer}
    />
  );

  // Mesma identidade na coluna do desktop e no painel do celular.
  const identity = <Identity name={session?.user?.name} role={session?.user?.role} photoPath={session?.user?.photoPath} />;

  if (totalItems === 1) return null;

  return (
    <>
      <aside
        className={`hidden lg:flex shrink-0 flex-col sticky top-14 h-[calc(100vh-3.5rem)] border-r border-stone-800 bg-stone-900/40 ${
          variant === "rail" ? "w-16" : "w-72"
        }`}
      >
        <div className="flex-1 overflow-y-auto">{menu()}</div>
        {variant === "full" && (
          <div className="shrink-0 border-t border-stone-800 p-3">{identity}</div>
        )}
      </aside>

      <Drawer open={drawerOpen} onClose={closeDrawer} panelId="app-menu-painel" label="Menu principal" panelClassName="w-full border-r">
        <div className="flex-1 overflow-y-auto">{menu()}</div>
        {/* Só a identidade: o "Sair" mora no canto do topo e sai daqui. O
            scrim do painel é `fixed inset-0 z-50` e cobre o header (`z-40`),
            então no celular ele só é alcançado com o painel fechado. */}
        <div className="shrink-0 border-t border-stone-800 p-3">{identity}</div>
      </Drawer>
    </>
  );
}

function Identity({ name, role, photoPath }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <UserAvatar name={name} photoPath={photoPath} className="w-8 h-8 text-[11px]" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-stone-200 truncate">{name ?? "—"}</p>
        <p className="text-[11px] text-stone-500 truncate">{ROLE_LABEL[role] ?? role}</p>
      </div>
    </div>
  );
}