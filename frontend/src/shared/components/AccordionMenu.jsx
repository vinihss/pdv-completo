import React from "react";
import { ChevronDown } from "lucide-react";

function Badge({ value }) {
  return (
    <span className="ml-auto bg-red-500 text-white rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-bold">
      {value}
    </span>
  );
}

/** Item do menu em linha (variante completa): ícone, rótulo e badge. */
function MenuItem({ item, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
        active ? "bg-amber-500 text-stone-950 font-semibold" : "text-stone-400 hover:text-stone-100 hover:bg-stone-800/60"
      }`}
    >
      <item.icon size={15} className="shrink-0" />
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
 * Menu em acordeão: seções expansíveis com itens dentro. Três formas de
 * seção de menu, todas no mesmo componente:
 *
 * - seção com mais de um item → cabeçalho clicável (expande/colapsa) + lista;
 * - seção com um item só → o cabeçalho É o item (nada de aninhar "Comandas >
 *   Comandas");
 * - `variant="rail"` → um item só por menu, sem seções: o perfil tem uma tela
 *   e um menu de 64px não pode custar a largura de uma sidebar.
 *
 * Burro de propósito: recebe as seções já montadas e não sabe o que é
 * comanda, estoque ou gerente — quem monta é `widgets/app-menu`.
 */
export default function AccordionMenu({ sections, activeId, onSelect, variant = "full", expanded, onToggleSection, footer }) {
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
        const isOpen = expanded.has(section.id);
        // O badge também vai no cabeçalho: com a seção recolhida, é a única
        // forma do sinal (estoque no mínimo) continuar visível.
        const sectionBadge = section.items.reduce((sum, i) => sum + (i.badge ?? 0), 0);

        // Seção de um item: o cabeçalho é o item, sem segundo nível.
        if (section.items.length === 1) {
          return <MenuItem key={section.id} item={section.items[0]} active={section.items[0].id === activeId} onSelect={onSelect} />;
        }

        return (
          <div key={section.id}>
            <button
              type="button"
              onClick={() => onToggleSection(section.id)}
              aria-expanded={isOpen}
              aria-controls={`menu-section-${section.id}`}
              className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-stone-500 hover:text-stone-200 hover:bg-stone-800/40 transition-colors"
            >
              <section.icon size={13} className="shrink-0" />
              <span className="text-[11px] font-bold uppercase tracking-wider truncate text-left">{section.label}</span>
              {sectionBadge > 0 && (
                <span className="bg-red-500/20 text-red-400 rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-bold">
                  {sectionBadge}
                </span>
              )}
              <ChevronDown
                size={14}
                className={`ml-auto shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
              />
            </button>
            {isOpen && (
              <div id={`menu-section-${section.id}`} role="group" aria-label={section.label} className="fade-up flex flex-col gap-0.5 pt-0.5">
                {section.items.map((item) => (
                  <MenuItem key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {footer}
    </nav>
  );
}
