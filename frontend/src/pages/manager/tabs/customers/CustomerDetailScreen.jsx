import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, Pencil, Star, Trash2 } from "lucide-react";
import {
  getCustomer,
  getCustomerSummary,
  listCustomerOrders,
  removeCustomerPhoto,
  uploadCustomerPhoto,
} from "@/entities/customer";
import { browserTzOffset } from "@/entities/reports";
import { ScreenHeader, Section } from "@/shared/components";
import { formatBRL, formatDateTime, initials, maskCnpjCpf, maskPhone, toDate } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";
import CustomerModal from "./CustomerModal.jsx";
import CustomerSpentChart from "./CustomerSpentChart.jsx";

// Prévia do histórico: 5 comandas chegam com a tela e o resto vem por
// "Carregar mais". Cliente que vem toda semana tem histórico longo, e abrir a
// ficha não pode custar uma requisição que devolve cem linhas para o gerente
// ler cinco.
const HISTORY_PAGE = 5;
// Teto do backend em `/customers/:id/orders`. É o que a tela de dia pede: sem
// filtro por data na rota, o dia selecionado sai de uma janela larga filtrada
// aqui, e 100 comandas cobrem qualquer cliente que não more na casa.
const HISTORY_WINDOW = 100;
const SUMMARY_DAYS = 30;

const ORDER_STATUS_LABEL = { open: "Em aberto", closed: "Fechada", cancelled: "Cancelada" };
const PAYMENT_LABEL = { cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" };

function orderLabel(order) {
  if (order.tableNumber) return `Mesa ${order.tableNumber}`;
  return order.tabLabel || "Comanda";
}

// O dia de uma comanda é o dia em que ela **entrou no gráfico**: só comanda
// fechada conta, e pelo `closedAt`. Usar `openedAt` faria a barra de um dia
// não bater com a lista daquele dia — uma conta aberta às 23h de sexta e
// fechada 00h30 de sábado vale no sábado, e o gerente precisa ver isso.
function dayKeyOf(order) {
  if (order.status !== "closed" || !order.closedAt) return null;
  const d = toDate(order.closedAt);
  if (!d || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <dt className="text-stone-500 shrink-0">{label}</dt>
      <dd className="text-stone-100 text-right min-w-0 break-words">
        {children || <span className="text-stone-600">—</span>}
      </dd>
    </div>
  );
}

function OrderRow({ order }) {
  const quando = order.closedAt ?? order.openedAt;
  return (
    <li className="flex items-center justify-between gap-3 bg-stone-900 border border-stone-800 rounded-xl px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{orderLabel(order)}</div>
        <div className="text-stone-500 text-xs truncate">
          {formatDateTime(quando)} · {order.itemCount ?? 0} {order.itemCount === 1 ? "item" : "itens"}
          {order.paymentMethod ? ` · ${PAYMENT_LABEL[order.paymentMethod] ?? order.paymentMethod}` : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold">{formatBRL(order.total)}</div>
        <div className="text-[11px] text-stone-500">{ORDER_STATUS_LABEL[order.status] ?? order.status}</div>
      </div>
    </li>
  );
}

export default function CustomerDetailScreen({ customerId, seed, onBack, showToast }) {
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [history, setHistory] = useState({ data: [], total: 0 });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // `null` = visão da prévia. Um dia selecionado troca a lista e o título.
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayOrders, setDayOrders] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoRef = useRef(null);

  const fetchHistory = useCallback(
    async (offset, append) => {
      if (append) setLoadingMore(true);
      else setHistoryLoading(true);
      try {
        const res = await listCustomerOrders(customerId, { limit: HISTORY_PAGE, offset });
        const data = res?.data ?? [];
        setHistory((prev) => ({
          data: append ? [...prev.data, ...data] : data,
          total: res?.total ?? data.length,
        }));
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        if (append) setLoadingMore(false);
        else setHistoryLoading(false);
      }
    },
    [customerId, showToast]
  );

  // Recarrega só o que a ficha mostra: cadastro e série. O histórico não muda
  // por editar o nome nem por trocar a foto.
  const reload = useCallback(async () => {
    try {
      setCustomer(await getCustomer(customerId));
    } catch (e) {
      showToast(e.message, "error");
    }
    try {
      setSummary(await getCustomerSummary(customerId, SUMMARY_DAYS, browserTzOffset()));
    } catch {
      // O gráfico é o menos importante da tela: um 404 aqui não pode apagar a
      // ficha nem trocar o "Sem compras no período." por um erro.
    }
  }, [customerId, showToast]);

  useEffect(() => {
    let cancelled = false;
    const alive = () => !cancelled;

    getCustomer(customerId)
      .then((d) => {
        if (alive()) setCustomer(d);
      })
      .catch((e) => {
        if (alive()) showToast(e.message, "error");
      })
      .finally(() => {
        if (alive()) setLoading(false);
      });

    getCustomerSummary(customerId, SUMMARY_DAYS, browserTzOffset())
      .then((s) => {
        if (alive()) setSummary(s);
      })
      .catch((e) => {
        if (alive()) showToast(e.message, "error");
      })
      .finally(() => {
        if (alive()) setSummaryLoading(false);
      });

    fetchHistory(0, false);

    return () => {
      cancelled = true;
    };
  }, [customerId, showToast, fetchHistory]);

  async function handlePickPhoto(file) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      await uploadCustomerPhoto(customerId, file);
      await reload();
      showToast("Foto atualizada.", "success");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPhotoBusy(false);
      // Zera o input: sem isso, escolher a mesma foto duas vezes não dispara
      // `onChange` e o cliente fica sem entender por que nada aconteceu.
      if (photoRef.current) photoRef.current.value = "";
    }
  }

  async function handleRemovePhoto() {
    setPhotoBusy(true);
    try {
      await removeCustomerPhoto(customerId);
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSelectDay(day) {
    // Clique no dia já selecionado volta para a prévia.
    if (selectedDay === day) {
      setSelectedDay(null);
      setDayOrders(null);
      return;
    }
    setSelectedDay(day);
    setDayLoading(true);
    setDayOrders([]);
    try {
      // A rota não filtra por data ainda, então o dia sai de uma janela larga
      // filtrada aqui — com a MESMA regra do gráfico (fechada + `closedAt`),
      // senão a barra e a lista discordariam sobre o mesmo dia.
      const res = await listCustomerOrders(customerId, { limit: HISTORY_WINDOW, offset: 0 });
      setDayOrders((res?.data ?? []).filter((o) => dayKeyOf(o) === day));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setDayLoading(false);
    }
  }

  function clearDay() {
    setSelectedDay(null);
    setDayOrders(null);
  }

  // Lista de dias para o "escolher dia" do gráfico. Barras do recharts são
  // `<rect>` dentro de um SVG, e clicar num `<rect>` não é testável de forma
  // útil (o jsdom não mede o container, então o gráfico nem desenha). A lista
  // é o MESMO `onSelectDay` — testar por ela cobre o caminho inteiro do clique,
  // que é onde mora o filtro por dia.
  async function selectDayByKeyboard(day) {
    await handleSelectDay(day);
  }

  const openOrders = customer?.openOrders ?? [];
  const maisAntiga = openOrders.reduce(
    (oldest, o) => (!oldest || (o.openedAt ?? "") < (oldest.openedAt ?? "") ? o : oldest),
    null
  );
  const dayLabel = summary?.series?.find((p) => p.day === selectedDay)?.label ?? selectedDay;
  const foto = customer?.photoPath;
  const nome = customer?.name ?? seed?.name ?? "Cliente";

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 flex flex-col">
      <div className="sticky top-0 bg-stone-950/95 backdrop-blur z-10">
        <ScreenHeader
          title={nome}
          subtitle={loading ? "Carregando…" : customer?.phone ? maskPhone(customer.phone) : undefined}
          onBack={onBack}
          right={
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="h-9 px-3 shrink-0 flex items-center gap-1.5 rounded-xl border border-stone-700 text-sm font-semibold text-stone-300 hover:text-amber-400 hover:border-amber-500/40 transition-colors"
            >
              <Pencil size={15} /> Editar
            </button>
          }
        />
      </div>

      <div className="flex-1">
        <div className="p-5 max-w-2xl mx-auto space-y-4 pb-24">
          {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

          {/* O aviso fica ACIMA de tudo e não some: quem abre a ficha de um
              cliente com conta em aberto precisa ver isso antes de qualquer
              número da tela. */}
          {openOrders.length > 0 && (
            <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 flex items-start gap-3">
              <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm min-w-0">
                <p className="font-semibold text-amber-200">
                  {openOrders.length === 1
                    ? "Este cliente tem 1 comanda em aberto"
                    : `Este cliente tem ${openOrders.length} comandas em aberto`}
                </p>
                {maisAntiga && (
                  <p className="text-amber-100/70 text-xs mt-0.5">
                    A mais antiga: {orderLabel(maisAntiga)} · aberta {formatDateTime(maisAntiga.openedAt)} ·{" "}
                    {formatBRL(maisAntiga.total)}
                  </p>
                )}
              </div>
            </div>
          )}

          {customer && (
            <Section title="Foto">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => photoRef.current?.click()}
                  disabled={photoBusy}
                  aria-label={foto ? "Trocar foto do cliente" : "Enviar foto do cliente"}
                  className="relative w-20 h-20 shrink-0 rounded-full disabled:opacity-50"
                >
                  {foto ? (
                    <img src={assetUrl(foto)} alt={nome} className="w-20 h-20 rounded-full object-cover border border-stone-700" />
                  ) : (
                    <span className="w-20 h-20 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-400 font-bold text-xl">
                      {initials(nome)}
                    </span>
                  )}
                  <span className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-amber-500 text-stone-950 flex items-center justify-center">
                    <Camera size={15} />
                  </span>
                </button>
                <div className="text-xs text-stone-500 space-y-1.5">
                  {foto && (
                    <button
                      type="button"
                      onClick={handleRemovePhoto}
                      disabled={photoBusy}
                      className="flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      <Trash2 size={12} /> Remover foto
                    </button>
                  )}
                  <p>Toque na foto para enviar. No celular, a câmera abre direto.</p>
                </div>
                {/* `capture` é o que faz o Android/iOS abrirem a câmera em vez
                    da galeria — é o pedido, não um detalhe de implementação. */}
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => handlePickPhoto(e.target.files?.[0])}
                />
              </div>
            </Section>
          )}

          {customer && (
            <Section title="Cadastro">
              <dl className="space-y-2.5">
                <Row label="Nome">{customer.name}</Row>
                <Row label="Telefone">{customer.phone ? maskPhone(customer.phone) : null}</Row>
                <Row label="Email">{customer.email}</Row>
                <Row label="CPF">{customer.cpf ? maskCnpjCpf(customer.cpf) : null}</Row>
                <Row label="Situação">
                  <span className={customer.active ? "text-emerald-400" : "text-stone-500"}>
                    {customer.active ? "Ativo" : "Inativo"}
                  </span>
                </Row>
                <Row label="Cliente desde">{formatDateTime(customer.createdAt)}</Row>
              </dl>
              {customer.notes && (
                <div className="pt-1">
                  <div className="text-xs font-bold uppercase tracking-widest text-stone-500 mb-1.5">Observações</div>
                  <p className="text-sm text-stone-200 whitespace-pre-line">{customer.notes}</p>
                </div>
              )}
            </Section>
          )}

          {customer?.addresses?.length > 0 && (
            <Section title={`Endereços (${customer.addresses.length})`}>
              <ul className="space-y-2">
                {customer.addresses.map((a) => (
                  <li key={a.id} className="bg-stone-800/40 border border-stone-700/60 rounded-xl px-3 py-2.5 text-sm">
                    <div className="font-medium flex items-center gap-1.5">
                      {a.isDefault && <Star size={11} className="text-amber-400 shrink-0" />}
                      {a.label?.trim() || "Endereço"}
                    </div>
                    <div className="text-stone-400 text-xs mt-0.5">
                      {a.cep ? `${a.cep} · ` : ""}
                      {a.street}, {a.number}
                      {a.complement ? ` - ${a.complement}` : ""} · {a.neighborhood}, {a.city}
                      {a.state ? ` - ${a.state}` : ""}
                      {a.reference ? ` (${a.reference})` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={`Últimos ${SUMMARY_DAYS} dias`}>
            <CustomerSpentChart
              series={summary?.series ?? []}
              loading={summaryLoading}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
            />
            {summary?.totals?.total > 0 && (
              <div className="flex items-center justify-between text-sm border-t border-stone-800 pt-3">
                <span className="text-stone-500">Total no período</span>
                <span className="font-semibold">
                  {formatBRL(summary.totals.total)} · {summary.totals.orderCount}{" "}
                  {summary.totals.orderCount === 1 ? "comanda" : "comandas"}
                </span>
              </div>
            )}
            {/* Escolher o dia pela lista, não pelo toque no gráfico: funciona
                com teclado e leitor de tela, e serve de rota igual para o dia
                que o dedo escolheu no gráfico. */}
            {(summary?.series ?? []).length > 0 && (
              <div>
                <div className="text-[11px] font-bold uppercase tracking-widest text-stone-500 mb-2">
                  Escolher dia
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(summary.series ?? []).map((p) => (
                    <button
                      key={p.day}
                      type="button"
                      onClick={() => selectDayByKeyboard(p.day)}
                      aria-pressed={p.day === selectedDay}
                      className={`px-2.5 h-8 rounded-lg text-[12px] font-semibold border transition-colors ${
                        p.day === selectedDay
                          ? "border-amber-500 bg-amber-500/15 text-amber-200"
                          : "border-stone-800 bg-stone-900 text-stone-400 hover:text-amber-400 hover:border-amber-500/40"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section title={selectedDay ? `Pedidos de ${dayLabel}` : "Histórico"}>
            {selectedDay && (
              <button
                type="button"
                onClick={clearDay}
                className="w-full flex items-center justify-center gap-1.5 border border-stone-700 text-stone-300 hover:text-amber-400 hover:border-amber-500/40 text-sm font-semibold py-2.5 rounded-xl"
              >
                Ver todos os pedidos
              </button>
            )}

            {dayOrders !== null ? (
              <>
                {dayLoading && <div className="text-stone-600 text-center py-6">Carregando…</div>}
                {!dayLoading && dayOrders.length === 0 && (
                  <p className="text-stone-600 text-sm text-center py-6">
                    Nenhum pedido em {dayLabel}.
                  </p>
                )}
                <ul className="space-y-2">
                  {dayOrders.map((o) => (
                    <OrderRow key={o.id} order={o} />
                  ))}
                </ul>
              </>
            ) : (
              <>
                {historyLoading && <div className="text-stone-600 text-center py-6">Carregando…</div>}
                {!historyLoading && history.data.length === 0 && (
                  <p className="text-stone-600 text-sm text-center py-6">Nenhum pedido registrado.</p>
                )}
                <ul className="space-y-2">
                  {history.data.map((o) => (
                    <OrderRow key={o.id} order={o} />
                  ))}
                </ul>
                {!historyLoading && history.data.length < history.total && (
                  <button
                    type="button"
                    onClick={() => fetchHistory(history.data.length, true)}
                    disabled={loadingMore}
                    className="w-full border border-stone-700 text-stone-300 hover:text-amber-400 hover:border-amber-500/40 text-sm font-semibold py-2.5 rounded-xl disabled:opacity-50"
                  >
                    {loadingMore ? "Carregando…" : `Carregar mais (${history.total - history.data.length})`}
                  </button>
                )}
              </>
            )}
          </Section>
        </div>
      </div>

      {editOpen && (
        <CustomerModal
          customer={customer ?? seed}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await reload();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
