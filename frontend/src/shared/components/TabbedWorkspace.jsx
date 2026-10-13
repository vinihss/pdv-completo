import { useRef } from "react";

/**
 * Layout comum para telas administrativas com conjuntos de conteúdo relacionados.
 * As páginas controlam a aba ativa; o componente cuida da largura, hierarquia
 * visual, navegação acessível e painel associado.
 */
export default function TabbedWorkspace({
  id,
  eyebrow = "Gestão",
  title,
  description,
  actions,
  tabs,
  activeTab,
  onTabChange,
  children,
}) {
  const tabRefs = useRef([]);
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
  const selectedTab = tabs[activeIndex];

  function handleKeyDown(event, index) {
    let nextIndex;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    onTabChange(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  if (!selectedTab) return null;

  return (
    <div className="min-h-full w-full min-w-0 bg-background text-foreground">
      <header className="flex w-full flex-col gap-4 border-b border-border px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-6">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">{eyebrow}</p>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {description && <p className="mt-1.5 max-w-3xl text-sm text-text-secondary">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>

      <div className="sticky top-14 z-30 w-full border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
        <div role="tablist" aria-label={`Seções de ${title}`} className="flex w-full gap-1 overflow-x-auto">
          {tabs.map((tab, index) => {
            const selected = tab.id === selectedTab.id;
            return (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[index] = node; }}
                id={`${id}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={`flex min-h-12 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "border-primary text-foreground"
                    : "border-transparent text-text-muted hover:border-border hover:text-text-secondary"
                }`}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span aria-hidden="true" className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${selected ? "bg-primary/15 text-primary" : "bg-surface-overlay text-text-muted"}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <section
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${selectedTab.id}`}
        tabIndex={0}
        className="w-full min-w-0 px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
      >
        {children}
      </section>
    </div>
  );
}
