import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  ClipboardList,
  CreditCard,
  House,
  Package,
  RefreshCw,
  ShoppingCart,
  Store,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { listOrders } from "@/entities/order";
import { browserTzOffset, overviewReport, periodRange } from "@/entities/reports";
import { useAuth } from "@/app/providers/auth";
import { useNav } from "@/app/providers/nav";
import { Button, PageHeader } from "@/shared/components";
import { formatBRL } from "@/shared/lib";

const SHORTCUTS = [
  { id: "orders", label: "Comandas", description: "Acompanhe pedidos abertos", icon: ClipboardList },
  { id: "cash", label: "Caixa", description: "Sessão e movimentações", icon: Wallet },
  { id: "deliveries", label: "Entregas", description: "Fila e acompanhamento", icon: Truck },
  { id: "catalog", label: "Cadastros", description: "Produtos e categorias", icon: Package },
  { id: "customers", label: "Clientes", description: "Cadastro e histórico", icon: Users },
  { id: "reports.overview", label: "Relatórios", description: "Vendas e desempenho", icon: CreditCard },
];

function greetingFor(hour) {
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function formatToday() {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

export default function ManagerHome({ showToast }) {
  const { session, storeSettings } = useAuth();
  const { setActiveId } = useNav();
  const [sales, setSales] = useState(null);
  const [openOrders, setOpenOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const range = periodRange("today");
    const [salesResult, ordersResult] = await Promise.allSettled([
      overviewReport({
        from: range.from,
        to: range.to,
        groupBy: "hour",
        tz: browserTzOffset(),
      }),
      listOrders("open"),
    ]);

    if (salesResult.status === "fulfilled") setSales(salesResult.value);
    else setSales(null);
    if (ordersResult.status === "fulfilled") setOpenOrders(ordersResult.value.data.length);
    else setOpenOrders(null);

    const failed = salesResult.status === "rejected" || ordersResult.status === "rejected";
    setLoadError(failed);
    if (failed) showToast("Não foi possível carregar todos os indicadores. Tente atualizar.", "error");
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const shortcuts = useMemo(() => {
    const available = [...SHORTCUTS];
    if (storeSettings?.inventoryEnabled) {
      available.push({ id: "stock", label: "Estoque", description: "Níveis e movimentações", icon: Boxes });
    }
    if (storeSettings?.purchaseEnabled) {
      available.push({ id: "compras", label: "Compras", description: "Fornecedores e entradas", icon: ShoppingCart });
    }
    if (storeSettings?.ifoodIntegrationEnabled) {
      available.push({ id: "ifood", label: "iFood", description: "Pedidos e integração", icon: Store });
    }
    return available;
  }, [storeSettings?.inventoryEnabled, storeSettings?.purchaseEnabled, storeSettings?.ifoodIntegrationEnabled]);

  const firstName = session?.user?.name?.trim().split(/\s+/)[0];
  const dateLabel = formatToday();
  const indicators = [
    {
      label: "Vendas de hoje",
      value: sales ? formatBRL(sales.totals.totalSales) : "—",
      hint: "Comandas fechadas",
      icon: Wallet,
      tone: "text-emerald-400",
    },
    {
      label: "Comandas fechadas",
      value: sales ? sales.totals.orderCount : "—",
      hint: "Hoje",
      icon: ClipboardList,
      tone: "text-sky-400",
    },
    {
      label: "Ticket médio",
      value: sales ? formatBRL(sales.totals.avgTicket) : "—",
      hint: "Por comanda fechada",
      icon: CreditCard,
      tone: "text-violet-400",
    },
    {
      label: "Comandas abertas",
      value: openOrders ?? "—",
      hint: "Em atendimento agora",
      icon: ClipboardList,
      tone: "text-amber-400",
    },
  ];

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={`${greetingFor(new Date().getHours())}${firstName ? `, ${firstName}` : ""}`}
        description={`${dateLabel} · Aqui está o resumo da operação da sua loja.`}
        actions={(
          <Button variant="secondary" size="sm" onClick={load} disabled={loading} aria-label="Atualizar indicadores">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            Atualizar
          </Button>
        )}
      />

      <section aria-labelledby="home-indicators-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="home-indicators-title" className="font-display text-lg font-bold">Resumo de hoje</h2>
            <p className="mt-0.5 text-xs text-stone-500">Indicadores atualizados ao abrir ou ao tocar em Atualizar.</p>
          </div>
          {loading && <span className="text-xs text-stone-500" role="status">Atualizando…</span>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {indicators.map(({ label, value, hint, icon: Icon, tone }) => (
            <article key={label} className="ui-surface min-w-0 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-stone-400">{label}</p>
                  <p className="mt-2 truncate font-display text-2xl font-bold tabular-nums text-stone-100" aria-live="polite">
                    {loading && value === "—" ? <span className="text-stone-600">···</span> : value}
                  </p>
                </div>
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-800 ${tone}`} aria-hidden="true">
                  <Icon size={19} />
                </span>
              </div>
              <p className="mt-3 text-xs text-stone-500">{hint}</p>
            </article>
          ))}
        </div>
        {loadError && (
          <p className="text-xs text-amber-300" role="status">
            Alguns indicadores não foram carregados. Use “Atualizar” para tentar novamente.
          </p>
        )}
      </section>

      <section aria-labelledby="home-shortcuts-title" className="space-y-3">
        <div>
          <h2 id="home-shortcuts-title" className="font-display text-lg font-bold">Atalhos</h2>
          <p className="mt-0.5 text-xs text-stone-500">Acesse rapidamente as áreas mais usadas.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shortcuts.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveId(id)}
              className="group flex min-h-20 items-center gap-3 rounded-2xl border border-stone-800 bg-stone-900/70 p-4 text-left transition-colors hover:border-stone-700 hover:bg-stone-900"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-stone-800 text-amber-400 transition-colors group-hover:bg-amber-500/15" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-stone-100">{label}</span>
                <span className="mt-0.5 block truncate text-xs text-stone-500">{description}</span>
              </span>
              <ArrowRight size={16} className="shrink-0 text-stone-600 transition-transform group-hover:translate-x-0.5 group-hover:text-stone-300" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <p className="flex items-center gap-2 text-xs text-stone-600">
        <House size={14} aria-hidden="true" /> Os indicadores usam os dados registrados pelo sistema; vendas consideram comandas fechadas.
      </p>
    </main>
  );
}
