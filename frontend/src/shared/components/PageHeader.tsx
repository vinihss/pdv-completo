import React from "react";

/** Cabeçalho de conteúdo para páginas e abas, separado do cabeçalho global do app. */
export default function PageHeader({ title, description, actions, className = "" }) {
  return (
    <header
      className={`flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        <h1 className="font-display text-xl font-bold leading-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
