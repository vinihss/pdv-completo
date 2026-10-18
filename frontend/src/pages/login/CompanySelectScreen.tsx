import { Button } from "@/shared/components";
import { assetUrl } from "@/shared/lib/server";
import { Building2, Loader2 } from "lucide-react";
import React from "react";

/**
 * Seleção de EMPRESA (docs/26 §5): aparece só quando a conta tem vínculo com
 * mais de uma loja e o dispositivo não tem preferência gravada. O papel não
 * é escolhido aqui — ele vem do vínculo (`user.role`) devolvido pelo
 * select-tenant.
 */
export default function CompanySelectScreen({ companies, onSelect, loading, error, onBack }) {
  return (
    <div className="flex flex-col gap-5">
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {companies.map((company) => (
          <li key={company.slug}>
            <button
              type="button"
              onClick={() => onSelect(company.slug)}
              disabled={loading}
              className="w-full flex items-center gap-3 bg-surface border border-border hover:border-primary/50 hover:bg-surface-overlay rounded-2xl p-4 text-left transition-colors active:scale-[.98] disabled:opacity-60"
            >
              {company.primaryColor && (
                <span
                  aria-hidden="true"
                  className="w-1.5 h-10 rounded-full shrink-0"
                  style={{ backgroundColor: company.primaryColor }}
                />
              )}
              {company.logoUrl ? (
                <img
                  src={assetUrl(company.logoUrl)}
                  alt={`Logo de ${company.name}`}
                  className="w-12 h-12 rounded-full object-contain bg-surface-overlay border border-border shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                  <span className="font-display text-lg font-semibold text-primary-strong">
                    {company.name?.[0]?.toUpperCase() || <Building2 size={20} aria-hidden="true" />}
                  </span>
                </div>
              )}
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{company.name}</div>
                <div className="text-text-muted text-xs mt-0.5">Entrar nesta empresa</div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {loading && (
        <p className="flex items-center justify-center gap-2 text-text-muted text-sm" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Entrando…
        </p>
      )}

      <button
        type="button"
        onClick={onBack}
        disabled={loading}
        className="text-sm font-medium text-text-secondary hover:text-foreground underline-offset-4 hover:underline self-center disabled:opacity-50"
      >
        Entrar com outra conta
      </button>
    </div>
  );
}
