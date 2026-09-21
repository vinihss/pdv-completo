import React, { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Minus, ShoppingBag, ChevronLeft, MapPin, Check, ChefHat, Bike, PartyPopper, AlertTriangle, Search, X } from "lucide-react";
import {
  getStoreInfo,
} from "@/shared/api/store";
import {
  getPublicMenu,
  lookupPublicCustomer,
  createPublicOrder,
  getPublicOrderStatus,
} from "@/shared/api/public";
import { applyBrandPrimary } from "@/shared/lib";

function money(v) {
  return `R$ ${(v ?? 0).toFixed(2).replace(".", ",")}`;
}
function formatAddress(a) {
  return `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""} · ${a.neighborhood}, ${a.city}`;
}
function digitsOnly(v) {
  return (v ?? "").replace(/\D/g, "").slice(0, 11);
}
function maskPhone(raw) {
  const d = digitsOnly(raw);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const PAYMENT_OPTIONS = [
  { value: "cash", label: "Dinheiro" },
  { value: "card", label: "Cartão na entrega" },
  { value: "pix", label: "Pix" },
];

/**
 * Rota pública real (/pedido), sem AuthProvider/login — consome
 * /public/* no backend. Substitui o protótipo solto que existia antes.
 *
 * Simplificações conscientes em relação ao desenho original:
 * - Acompanhamento por polling (a cada 4s), não WebSocket — a rota /realtime
 *   exige JWT (verifyTokenRaw), e um cliente anônimo não tem token. Resolver
 *   isso direito exigiria autorização de sala pública no backend
 *   (ex: permitir entrar em `order:<id>` sem login, já que o UUID já
 *   funciona como "senha" de fato); não fiz isso agora.
 * - Sem seletor de variação de produto — o schema já comporta
 *   (`selectedVariations`), só a UI ainda não usa.
 *
 * Tema acompanha o app do sistema (dark, palette stone) e usa a cor da marca
 * como acento (--brand-accent / rampa amber sobreposta por applyBrandPrimary).
 */
export default function CustomerMenuPage() {
  const [searchParams] = useSearchParams();
  const viaWhatsApp = searchParams.get("via") === "whatsapp";
  const prefilledPhone = searchParams.get("phone") ?? "";

  const [menu, setMenu] = useState(null);
  const [menuError, setMenuError] = useState(null);
  const [storeInfo, setStoreInfo] = useState(null); // /store-info (logo, nome)
  const [deliveryAvailable, setDeliveryAvailable] = useState(null); // null = checando
  const [screen, setScreen] = useState("menu");
  const [cart, setCart] = useState({});
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const [checkoutStep, setCheckoutStep] = useState("phone");
  const [phone, setPhone] = useState(() => maskPhone(prefilledPhone));
  const [customer, setCustomer] = useState(null); // { customerId, name, addresses } | null
  const [selectedAddressId, setSelectedAddressId] = useState(null);
  const [newAddress, setNewAddress] = useState({ label: "", street: "", number: "", complement: "", neighborhood: "", city: "", reference: "" });
  const [payment, setPayment] = useState(null);
  const [notes, setNotes] = useState({}); // observações por produto no carrinho
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [order, setOrder] = useState(null); // resultado de createPublicOrder
  const [statusPoll, setStatusPoll] = useState(null); // { orderStatus, itemsStatus, deliveryStatus }

  useEffect(() => {
    getStoreInfo()
      .then((info) => {
        setStoreInfo(info);
        setDeliveryAvailable(info?.usesDelivery !== false);
        applyBrandPrimary(info?.brandColor);
      })
      .catch(() => setDeliveryAvailable(true));
    getPublicMenu()
      .then((m) => {
        setMenu(m);
        setSelectedCategory("all");
      })
      .catch((e) => setMenuError(e.message));
  }, []);

  const allProducts = menu?.categories.flatMap((c) => c.products.map((p) => ({ ...p, categoryName: c.name }))) ?? [];
  const cartItems = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => ({ ...allProducts.find((p) => p.id === id), quantity: qty }));
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const itemCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const deliveryFee = storeInfo?.deliveryFee ?? 0;
  const paymentOptions = PAYMENT_OPTIONS.filter(
    (o) => !storeInfo?.enabledPaymentMethods || storeInfo.enabledPaymentMethods.includes(o.value)
  );

  // Filtro combinado: categoria (pill) + busca por nome/descrição.
  const query = searchTerm.trim().toLowerCase();
  const visibleCategories = (menu?.categories ?? [])
    .filter((c) => selectedCategory === "all" || c.id === selectedCategory)
    .map((c) => ({
      ...c,
      products: c.products.filter(
        (p) => !query || p.name.toLowerCase().includes(query) || (p.description ?? "").toLowerCase().includes(query)
      ),
    }))
    .filter((c) => c.products.length > 0);

  function addToCart(id) {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  }
  function removeFromCart(id) {
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) - 1) }));
  }

  async function startCheckout() {
    setScreen("checkout");
    setCheckoutError(null);
    if (viaWhatsApp && prefilledPhone) {
      await runLookup(prefilledPhone);
    } else {
      setCheckoutStep("phone");
    }
  }

  async function runLookup(phoneToLookup) {
    const lookup = digitsOnly(phoneToLookup);
    if (!lookup) return;
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const result = await lookupPublicCustomer(lookup);
      setCustomer(result);
      setSelectedAddressId(result.addresses[0]?.id ?? null);
      setCheckoutStep(result.addresses.length > 0 ? "address" : "new-address");
    } catch (e) {
      if (e.code === "not_found") {
        setCustomer(null);
        setCheckoutStep("new-address");
      } else {
        setCheckoutError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function resetOrder() {
    setCart({});
    setNotes({});
    setScreen("menu");
    setCheckoutStep("phone");
    setCustomer(null);
    setSelectedAddressId(null);
    setNewAddress({ label: "", street: "", number: "", complement: "", neighborhood: "", city: "", reference: "" });
    setPayment(null);
    setOrder(null);
    setStatusPoll(null);
    setCheckoutError(null);
  }

  async function submitOrder() {
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const created = await createPublicOrder({
        channel: viaWhatsApp ? "whatsapp" : "web",
        customerPhone: digitsOnly(phone),
        customerName: customer?.name ?? newAddress.customerName ?? "Cliente",
        addressId: selectedAddressId ?? undefined,
        newAddress: selectedAddressId
          ? undefined
          : {
              label: newAddress.label || undefined,
              street: newAddress.street,
              number: newAddress.number,
              complement: newAddress.complement || undefined,
              neighborhood: newAddress.neighborhood,
              city: newAddress.city,
              reference: newAddress.reference || undefined,
              isDefault: true,
            },
        items: cartItems.map((i) => ({ productId: i.id, quantity: i.quantity, notes: notes[i.id]?.trim() || undefined })),
        paymentMethodIntent: payment,
      });
      setOrder(created);
      setScreen("confirmation");
    } catch (e) {
      setCheckoutError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Polling de status — sem WebSocket pra cliente anônimo (ver nota no topo).
  const pollStatus = useCallback(async () => {
    if (!order) return;
    try {
      const s = await getPublicOrderStatus(order.orderId);
      setStatusPoll(s);
    } catch {
      // falha de rede pontual não derruba a tela — tenta de novo no próximo ciclo
    }
  }, [order]);

  useEffect(() => {
    if (screen !== "confirmation" || !order) return;
    pollStatus();
    const terminal = statusPoll?.deliveryStatus === "delivered" || statusPoll?.deliveryStatus === "failed";
    if (terminal) return;
    const t = setInterval(pollStatus, 4000);
    return () => clearInterval(t);
  }, [screen, order, pollStatus, statusPoll?.deliveryStatus]);

  if (deliveryAvailable === false) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-50 flex items-center justify-center p-6">
        <div className="max-w-sm w-full bg-stone-900 border border-stone-800 rounded-3xl p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-stone-800 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={22} className="text-amber-400" />
          </div>
          <p className="text-stone-100 font-semibold mb-1">Pedidos por delivery desativados</p>
          <p className="text-stone-500 text-sm">O estabelecimento não está recebendo pedidos on-line no momento. Entre em contato diretamente com ele.</p>
        </div>
      </div>
    );
  }
  if (menuError) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-50 flex items-center justify-center p-6">
        <p className="text-stone-500 text-sm text-center">Não foi possível carregar o cardápio agora. Tente de novo em alguns minutos.</p>
      </div>
    );
  }
  if (!menu) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-50 flex justify-center">
        <div className="w-full max-w-[430px] min-h-screen bg-stone-950 relative flex flex-col">
          <div className="px-5 pt-6 pb-4 border-b border-stone-800">
            <div className="mb-4">
              <div className="h-14 w-14 rounded-full bg-stone-800 animate-pulse" />
            </div>
            <div className="h-3 w-32 rounded bg-stone-800 animate-pulse mb-2" />
            <div className="h-7 w-44 rounded bg-stone-700/60 animate-pulse" />
          </div>
          <div className="flex gap-2 px-5 py-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-8 w-20 rounded-full bg-stone-800 animate-pulse" />
            ))}
          </div>
          <div className="px-5 pt-5 space-y-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-stone-800">
                <div className="space-y-2">
                  <div className="h-4 w-40 rounded bg-stone-700/60 animate-pulse" />
                  <div className="h-3 w-28 rounded bg-stone-800 animate-pulse" />
                </div>
                <div className="h-9 w-9 rounded-full bg-stone-800 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-950 font-sans text-stone-50 flex justify-center">
      <div className="w-full max-w-[430px] min-h-screen bg-stone-950 relative flex flex-col">
        {screen === "menu" && (
          <MenuScreen
            menu={menu}
            viaWhatsApp={viaWhatsApp}
            logoUrl={storeInfo?.logoUrl}
            merchantName={storeInfo?.merchantName}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            visibleCategories={visibleCategories}
            cart={cart}
            addToCart={addToCart}
            removeFromCart={removeFromCart}
            itemCount={itemCount}
            subtotal={subtotal}
            onOpenCart={() => setScreen("cart")}
          />
        )}

        {screen === "cart" && (
          <CartScreen
            items={cartItems}
            subtotal={subtotal}
            logoUrl={storeInfo?.logoUrl}
            addToCart={addToCart}
            removeFromCart={removeFromCart}
            notes={notes}
            onNotesChange={(id, text) => setNotes((n) => ({ ...n, [id]: text }))}
            onBack={() => setScreen("menu")}
            onCheckout={startCheckout}
          />
        )}

        {screen === "checkout" && (
          <CheckoutScreen
            step={checkoutStep}
            setStep={setCheckoutStep}
            phone={phone}
            setPhone={setPhone}
            onLookup={() => runLookup(phone)}
            customer={customer}
            selectedAddressId={selectedAddressId}
            setSelectedAddressId={setSelectedAddressId}
            newAddress={newAddress}
            setNewAddress={setNewAddress}
            payment={payment}
            setPayment={setPayment}
            items={cartItems}
            subtotal={subtotal}
            deliveryFee={deliveryFee}
            paymentOptions={paymentOptions}
            logoUrl={storeInfo?.logoUrl}
            onBack={() => setScreen("cart")}
            onSubmit={submitOrder}
            submitting={submitting}
            error={checkoutError}
          />
        )}

        {screen === "confirmation" && order && (
          <ConfirmationScreen order={order} status={statusPoll} onReset={resetOrder} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function MenuScreen({ menu, viaWhatsApp, logoUrl, merchantName, selectedCategory, onSelectCategory, searchTerm, onSearchChange, visibleCategories, cart, addToCart, removeFromCart, itemCount, subtotal, onOpenCart }) {
  const pill = (active) =>
    `shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
      active ? "bg-amber-500 text-[var(--brand-accent-foreground)]" : "bg-stone-900 text-stone-300 border border-stone-800"
    }`;

  return (
    <>
      <div className="px-5 pt-5 pb-4 border-b border-stone-800">
        <p className="text-[11px] tracking-[0.18em] uppercase text-amber-400/80 font-semibold mb-3">Pedido para entrega</p>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt="Logo do restaurante" className="h-14 w-14 rounded-full object-contain shrink-0" />
          ) : (
            <div className="h-14 w-14 rounded-full bg-stone-800 flex items-center justify-center text-amber-400 shrink-0">
              <span className="font-display text-lg font-bold">{(merchantName?.[0] ?? "B").toUpperCase()}</span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold tracking-tight truncate">{merchantName || "Cardápio"}</h1>
            <p className="text-[12.5px] text-stone-500 mt-0.5">Cardápio · peça online</p>
          </div>
          {viaWhatsApp && <span className="shrink-0 text-[10.5px] font-semibold bg-[#25D366]/15 text-[#25D366] px-2 py-0.5 rounded-full">Via WhatsApp</span>}
        </div>
      </div>

      <div className="sticky top-0 z-10 bg-stone-950/95 backdrop-blur border-b border-stone-800 px-5 pt-3 pb-3 space-y-2.5">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500 pointer-events-none" />
          <input
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar produto"
            className="w-full bg-stone-900 border border-stone-800 rounded-lg pl-9 pr-8 h-10 text-[14px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-500"
          />
          {searchTerm && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
              aria-label="Limpar busca"
            >
              <X size={15} />
            </button>
          )}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          <button onClick={() => onSelectCategory("all")} className={pill(selectedCategory === "all")}>
            Todos
          </button>
          {menu.categories.map((c) => (
            <button key={c.id} onClick={() => onSelectCategory(c.id)} className={pill(selectedCategory === c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 px-5 pb-28">
        {visibleCategories.length === 0 ? (
          <p className="text-stone-500 text-sm text-center mt-10">Nenhum produto encontrado.</p>
        ) : (
          visibleCategories.map((c) => (
            <div key={c.id} className="pt-5">
              <h2 className="text-[13px] font-bold uppercase tracking-wide text-stone-500 mb-2">{c.name}</h2>
              {c.products.map((p) => {
                const qty = cart[p.id] ?? 0;
                return (
                  <div key={p.id} className="flex items-center justify-between py-3 border-b border-stone-800 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {p.imagePath && (
                        <img src={p.imagePath} alt={p.name} className="w-14 h-14 rounded-lg object-cover shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-[14.5px] font-semibold leading-tight text-stone-50">{p.name}</p>
                        {p.description && <p className="text-[11.5px] text-stone-500 leading-snug mt-0.5 line-clamp-2">{p.description}</p>}
                        <p className="text-[13.5px] text-amber-400 font-semibold mt-1">{money(p.price)}</p>
                      </div>
                    </div>
                    {qty === 0 ? (
                      <button onClick={() => addToCart(p.id)} className="shrink-0 w-9 h-9 rounded-full bg-amber-500 flex items-center justify-center" aria-label={`Adicionar ${p.name}`}>
                        <Plus size={17} className="text-[var(--brand-accent-foreground)]" />
                      </button>
                    ) : (
                      <div className="shrink-0 flex items-center gap-2.5 bg-stone-900 border border-stone-800 rounded-full px-1 py-1">
                        <button onClick={() => removeFromCart(p.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Diminuir quantidade">
                          <Minus size={14} />
                        </button>
                        <span className="text-[13.5px] font-semibold w-4 text-center text-stone-50">{qty}</span>
                        <button onClick={() => addToCart(p.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Aumentar quantidade">
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {itemCount > 0 && (
        <button onClick={onOpenCart} className="absolute bottom-5 left-5 right-5 bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl py-3.5 px-4 flex items-center justify-between font-semibold shadow-lg shadow-black/30">
          <span className="flex items-center gap-2 text-[14px]">
            <ShoppingBag size={17} />
            Ver carrinho · {itemCount} {itemCount === 1 ? "item" : "itens"}
          </span>
          <span className="text-[14px]">{money(subtotal)}</span>
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function CartScreen({ items, subtotal, logoUrl, addToCart, removeFromCart, notes, onNotesChange, onBack, onCheckout }) {
  const [openNote, setOpenNote] = useState(null);
  return (
    <>
      <TopBar title="Seu carrinho" onBack={onBack} logoUrl={logoUrl} />
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {items.length === 0 ? (
          <p className="text-stone-500 text-sm mt-8 text-center">Carrinho vazio.</p>
        ) : (
          items.map((it) => (
            <div key={it.id} className="py-3 border-b border-stone-800">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold text-stone-50">{it.name}</p>
                  <p className="text-[13px] text-stone-500 mt-0.5">{money(it.price)} cada</p>
                </div>
                <div className="shrink-0 flex items-center gap-2.5 bg-stone-900 border border-stone-800 rounded-full px-1 py-1">
                  <button onClick={() => removeFromCart(it.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Diminuir quantidade">
                    <Minus size={14} />
                  </button>
                  <span className="text-[13.5px] font-semibold w-4 text-center text-stone-50">{it.quantity}</span>
                  <button onClick={() => addToCart(it.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Aumentar quantidade">
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <button
                onClick={() => setOpenNote(openNote === it.id ? null : it.id)}
                className="mt-2 text-[12px] font-medium text-amber-400"
              >
                {notes[it.id]?.trim() ? "Editar observação" : "+ Adicionar observação"}
              </button>
              {openNote === it.id && (
                <textarea
                  value={notes[it.id] ?? ""}
                  onChange={(e) => onNotesChange(it.id, e.target.value)}
                  placeholder="Ex.: sem cebola, capricha no queijo..."
                  rows={2}
                  className="mt-2 w-full bg-stone-900 border border-stone-800 rounded-lg px-3 py-2 text-[13.5px] text-stone-100 outline-none focus:border-amber-500"
                />
              )}
            </div>
          ))
        )}
      </div>
      {items.length > 0 && (
        <div className="px-5 pb-6 pt-3 border-t border-stone-800">
          <p className="text-[11.5px] text-stone-500 mb-3">A taxa de entrega é calculada no próximo passo.</p>
          <button onClick={onCheckout} className="w-full bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl h-12 font-semibold text-[14.5px]">
            Continuar · {money(subtotal)}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function CheckoutScreen(props) {
  const { step, setStep, phone, setPhone, onLookup, customer, selectedAddressId, setSelectedAddressId, newAddress, setNewAddress, payment, setPayment, items, subtotal, deliveryFee, paymentOptions, logoUrl, onBack, onSubmit, submitting, error } = props;
  const titles = { phone: "Identificação", address: "Endereço de entrega", "new-address": "Endereço de entrega", payment: "Pagamento", review: "Confirmar pedido" };

  return (
    <>
      <TopBar
        title={titles[step]}
        logoUrl={logoUrl}
        onBack={() => {
          if (step === "phone") onBack();
          else if (step === "address" || step === "new-address") setStep("phone");
          else if (step === "payment") setStep(customer?.addresses?.length ? "address" : "new-address");
          else setStep("payment");
        }}
      />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-[13px] bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-4">
            <AlertTriangle size={14} className="shrink-0" /> {error}
          </div>
        )}

        {step === "phone" && (
          <div>
            <p className="text-[13.5px] text-stone-500 mb-3">Pra identificar seu pedido e endereços salvos, informe seu telefone.</p>
            <input
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && digitsOnly(phone)) onLookup();
              }}
              placeholder="(11) 99999-0000"
              inputMode="tel"
              className="w-full bg-stone-900 border border-stone-800 rounded-lg px-4 h-12 text-[15px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-500"
            />
          </div>
        )}

        {step === "address" && (
          <div className="space-y-2.5">
            {customer?.addresses.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedAddressId(a.id)}
                className={`w-full text-left rounded-lg border p-3.5 flex items-start gap-3 ${selectedAddressId === a.id ? "border-amber-500 bg-amber-500/10" : "border-stone-800 bg-stone-900"}`}
              >
                <MapPin size={17} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-stone-50">{a.label || "Endereço"}</p>
                  <p className="text-[12.5px] text-stone-500 mt-0.5">{formatAddress(a)}</p>
                </div>
                {selectedAddressId === a.id && <Check size={17} className="ml-auto shrink-0 text-amber-400" />}
              </button>
            ))}
            <button onClick={() => { setSelectedAddressId(null); setStep("new-address"); }} className="w-full text-left rounded-lg border border-dashed border-stone-700 p-3.5 text-[13.5px] text-stone-400">
              + Usar um novo endereço
            </button>
          </div>
        )}

        {step === "new-address" && (
          <div className="space-y-3">
            <Field label="Rótulo (opcional)" value={newAddress.label} onChange={(v) => setNewAddress({ ...newAddress, label: v })} placeholder="Casa, Trabalho..." />
            <div className="flex gap-3">
              <Field label="Rua" value={newAddress.street} onChange={(v) => setNewAddress({ ...newAddress, street: v })} className="flex-[2]" />
              <Field label="Número" value={newAddress.number} onChange={(v) => setNewAddress({ ...newAddress, number: v })} className="flex-1" />
            </div>
            <Field label="Complemento (opcional)" value={newAddress.complement} onChange={(v) => setNewAddress({ ...newAddress, complement: v })} />
            <Field label="Bairro" value={newAddress.neighborhood} onChange={(v) => setNewAddress({ ...newAddress, neighborhood: v })} />
            <Field label="Cidade" value={newAddress.city} onChange={(v) => setNewAddress({ ...newAddress, city: v })} />
            <Field label="Ponto de referência (opcional)" value={newAddress.reference} onChange={(v) => setNewAddress({ ...newAddress, reference: v })} />
            {!customer && (
              <Field label="Seu nome" value={newAddress.customerName ?? ""} onChange={(v) => setNewAddress({ ...newAddress, customerName: v })} />
            )}
          </div>
        )}

        {step === "payment" && (
          <div className="space-y-2.5">
            {paymentOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPayment(opt.value)}
                className={`w-full text-left rounded-lg border p-3.5 flex items-center justify-between ${payment === opt.value ? "border-amber-500 bg-amber-500/10" : "border-stone-800 bg-stone-900"}`}
              >
                <span className="text-[14px] font-medium text-stone-50">{opt.label}</span>
                {payment === opt.value && <Check size={17} className="text-amber-400" />}
              </button>
            ))}
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="rounded-lg bg-stone-900 border border-stone-800 p-4 mb-4">
              {items.map((it) => (
                <div key={it.id} className="flex justify-between text-[13.5px] py-1 text-stone-300">
                  <span>{it.quantity}x {it.name}</span>
                  <span className="text-stone-500">{money(it.price * it.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-stone-800 mt-2 pt-2 flex justify-between text-[14px] font-bold text-stone-50">
                <span>Subtotal</span><span>{money(subtotal)}</span>
              </div>
              <div className="flex justify-between text-[13.5px] py-1">
                <span className="text-stone-300">Taxa de entrega</span><span className="text-stone-500">{money(deliveryFee)}</span>
              </div>
              <div className="flex justify-between text-[15px] font-extrabold pt-1">
                <span className="text-stone-50">Total</span><span className="text-amber-400">{money(subtotal + deliveryFee)}</span>
              </div>
            </div>
            <div className="rounded-lg bg-stone-900 border border-stone-800 p-4 mb-4 space-y-1.5">
              <div className="flex items-start gap-2 text-[13.5px] text-stone-300">
                <MapPin size={15} className="mt-0.5 shrink-0 text-amber-400" />
                <span>{selectedAddressId ? formatAddress(customer.addresses.find((a) => a.id === selectedAddressId)) : formatAddress(newAddress)}</span>
              </div>
              <p className="text-[13.5px] text-stone-500 pl-5.5 ml-0.5">Pagamento: {paymentOptions.find((o) => o.value === payment)?.label}</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 pb-6 pt-3 border-t border-stone-800">
        <button
          disabled={
            submitting ||
            (step === "phone" && !phone.trim()) ||
            (step === "new-address" && (!newAddress.street || !newAddress.number || !newAddress.neighborhood || !newAddress.city || (!customer && !newAddress.customerName))) ||
            (step === "payment" && !payment)
          }
          onClick={() => {
            if (step === "phone") onLookup();
            else if (step === "address") setStep("payment");
            else if (step === "new-address") setStep("payment");
            else if (step === "payment") setStep("review");
            else onSubmit();
          }}
          className="w-full bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl h-12 font-semibold text-[14.5px] disabled:opacity-40"
        >
          {submitting ? "Enviando…" : step === "review" ? `Confirmar pedido · ${money(subtotal + deliveryFee)}` : "Continuar"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function ConfirmationScreen({ order, status, onReset }) {
  const steps = [
    { icon: Check, label: "Pedido recebido" },
    { icon: ChefHat, label: "Preparando" },
    { icon: Bike, label: "Saiu para entrega" },
    { icon: PartyPopper, label: "Entregue" },
  ];
  const deliveryStatus = status?.deliveryStatus;
  const failed = deliveryStatus === "failed";
  const stageIndex = failed ? 1 : { awaiting_courier: 1, out_for_delivery: 2, delivered: 3 }[deliveryStatus] ?? 0;

  return (
    <div className="flex-1 flex flex-col px-6 pt-10 pb-8">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center mx-auto mb-4">
          <Check size={26} className="text-amber-400" />
        </div>
        <h1 className="text-xl font-extrabold text-stone-50">Pedido confirmado!</h1>
        <p className="text-[13.5px] text-stone-500 mt-1">Tempo estimado: {order.estimatedMinutes} min · Total {money(order.total)}</p>
      </div>

      {failed && (
        <div className="flex items-center gap-2 text-red-400 text-[13px] bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-6">
          <AlertTriangle size={14} className="shrink-0" /> Tivemos um problema pra entregar seu pedido. Entraremos em contato.
        </div>
      )}

      <div className="space-y-0">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const done = stageIndex >= i;
          const isLast = i === steps.length - 1;
          return (
            <div key={i} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors duration-500 ${done ? "bg-amber-500 text-[var(--brand-accent-foreground)]" : "bg-stone-900 text-stone-500 border border-stone-800"}`}>
                  <Icon size={16} />
                </div>
                {!isLast && <div className={`w-0.5 flex-1 min-h-[28px] transition-colors duration-500 ${stageIndex > i ? "bg-amber-500" : "bg-stone-800"}`} />}
              </div>
              <div className="pb-7 pt-1.5">
                <p className={`text-[14px] font-medium transition-colors duration-500 ${done ? "text-stone-50" : "text-stone-500"}`}>{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-[11.5px] text-stone-500 mt-2">Esta tela atualiza sozinha — não precisa dar refresh.</p>

      <button
        onClick={onReset}
        className="w-full mt-8 bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl h-12 font-semibold text-[14.5px]"
      >
        Fazer um novo pedido
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TopBar({ title, onBack, logoUrl }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-stone-800 shrink-0 text-stone-50">
      <button onClick={onBack} className="w-8 h-8 -ml-1.5 flex items-center justify-center" aria-label="Voltar">
        <ChevronLeft size={22} />
      </button>
      <h1 className="text-[15.5px] font-semibold text-stone-50">{title}</h1>
      {logoUrl && (
        <img src={logoUrl} alt="Logo do restaurante" className="h-9 w-9 rounded-full object-contain shrink-0 ml-auto" />
      )}
    </div>
  );
}
function Field({ label, value, onChange, placeholder, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[12px] text-stone-500 mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-stone-900 border border-stone-800 rounded-lg px-3.5 h-11 text-[14px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-500"
      />
    </label>
  );
}