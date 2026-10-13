import React from "react";

function Badge({ value }) {
  return (
    <span className="ml-auto bg-red-500 text-white rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-bold">
      {value}
    </span>
  );
}

/** Item do menu em linha (variante completa): ícone, rótulo e badge. */
function MenuItem({ item, active, onSelect, nested = false }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors relative ${
        nested ? "pl-7" : ""
      } ${active ? "bg-amber-500/10 text-amber-400 font-semibold border-l-2 border-amber-500 pl-2.5" : "text-stone-400 hover:text-stone-100 hover:bg-stone-800/60"}`}
    >
      <item.icon size={nested ? 14 : 15} className="shrink-0" />
      <span className="truncate text-left">{item.label}</span>
      {!active && item.badge > 0 && <Badge value={item.badge} />}
    </button>
  );
}

/** Item do menu no trilho: ícone em cima do rótulo curto. */
function RailItem({ item, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={`w-full flex flex-col items-center gap-1 rounded-xl py-2 px-1 transition-colors ${
        active ? "bg-amber-500 text-stone-950" : "text-stone-500 hover:text-stone-100 hover:bg-stone-800/60"
      }`}
    >
      <item.icon size={19} className="shrink-0" />
      <span className="w-full text-[10px] font-semibold leading-tight truncate text-center">{item.label}</span>
    </button>
  );
}

/**
 * Menu lateral com submenus sempre visíveis: seções e itens com filhos
 * (terceiro nível) são renderizados expandidos, sem clique para abrir/fechar.
 * Três formas de seção de menu, todas no mesmo componente:
 *
 * - seção com mais de um item → cabeçalho (label não-clicável) + lista;
 * - seção com um item só → o cabeçalho É o item (nada de aninhar "Comandas >
 *   Comandas");
 * - `variant="rail"` → um item só por menu, sem seções: o perfil tem uma tela
 *   e um menu de 64px não pode custar a largura de uma sidebar.
 *
 * Burro de propósito: recebe as seções já montadas e não sabe o que é
 * comanda, estoque ou gerente — quem monta é `widgets/app-menu`.
 *
 * O submenu (`item.children`) é um grupo, não uma tela: o pai é um label e
 * os filhos são as telas navegáveis. O pai fica visualmente ativo quando
 * algum filho é a tela atual — é o que dá a sensação de "onde eu estou" ao
 * olhar a coluna.
 *
 * As props `expanded`, `onToggleSection`, `expandedItems` e `onToggleItem`
 * são mantidas na assinatura para compatibilidade com consumidores anteriores,
 * mas são ignoradas — o menu é sempre expandido.
 */
export default function AccordionMenu({ sections, activeId, onSelect, variant = "full", footer }) {
  if (variant === "rail") {
    const items = sections.flatMap((s) => s.items);
    return (
      <nav aria-label="Menu principal" className="flex flex-col gap-1 p-2">
        {items.map((item) => (
          <RailItem key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Menu principal" className="flex flex-col gap-1 p-2">
      {sections.map((section) => {
        // O badge também vai no cabeçalho: é a única forma do sinal
        // (estoque no mínimo) continuar visível quando a seção está recolhida.
        const sectionBadge = section.items.reduce((sum, i) => sum + (i.badge ?? 0), 0);

        // Seção de um item: o cabeçalho é o item, sem segundo nível.
        if (section.items.length === 1) {
          return <MenuItem key={section.id} item={section.items[0]} active={section.items[0].id === activeId} onSelect={onSelect} />;
        }

        return (
          <div key={section.id}>
            <div
              className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-stone-500"
            >
              <section.icon size={12} className="shrink-0 opacity-50" />
              <span className="text-[10px] font-bold uppercase tracking-widest truncate text-left opacity-60">{section.label}</span>
              {sectionBadge > 0 && (
                <span className="bg-red-500/20 text-red-400 rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-bold">
                  {sectionBadge}
                </span>
              )}
            </div>
            <div role="group" aria-label={section.label} className="flex flex-col gap-0.5 pt-0.5">
              {section.items.map((item) => (
                <ItemWithSubmenu
                  key={item.id}
                  item={item}
                  activeId={activeId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        );
      })}
      {footer}
    </nav>
  );
}

/** Item comum ou, se tiver `children`, um label com a lista sempre visível abaixo. */
function ItemWithSubmenu({ item, activeId, onSelect }) {
  if (!item.children?.length) {
    return <MenuItem item={item} active={item.id === activeId} onSelect={onSelect} />;
  }

  // Um filho ativo conta como pai ativo — o item é apenas o guarda-chuva da
  // seção "Gestão", mas o usuário precisa saber em qual relatório está.
  const activeChild = item.children.some((c) => c.id === activeId);

  return (
    <div>
      <div
        aria-current={activeChild ? "true" : undefined}
        className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm ${
          activeChild ? "bg-stone-800/60 text-stone-100 font-semibold" : "text-stone-400"
        }`}
      >
        <item.icon size={15} className="shrink-0" />
        <span className="truncate text-left">{item.label}</span>
      </div>
      <div role="group" aria-label={item.label} className="flex flex-col gap-0.5">
        {item.children.map((child) => (
          <MenuItem key={child.id} item={child} active={child.id === activeId} onSelect={onSelect} nested />
        ))}
      </div>
    </div>
  );
}