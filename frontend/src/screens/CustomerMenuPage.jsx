import React, { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Minus, ShoppingBag, ChevronLeft, MapPin, Check, Clock, ChefHat, Bike, PartyPopper, AlertTriangle } from "lucide-react";
import { api } from "../lib/api.js";

function money(v) {
  return `R$ ${(v ?? 0).toFixed(2).replace(".", ",")}`;
}
function formatAddress(a) {
  return `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""} · ${a.neighborhood}, ${a.city}`;
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
 */
export default function CustomerMenuPage() {
  const [searchParams] = useSearchParams();
  const viaWhatsApp = searchParams.get("via") === "whatsapp";
  const prefilledPhone = searchParams.get("phone") ?? "";

  const [menu, setMenu] = useState(null);
  const [menuError, setMenuError] = useState(null);
  const [screen, setScreen] = useState("menu");
  const [cart, setCart] = useState({});
  const [activeCategory, setActiveCategory] = useState(null);
  const scrollRefs = useRef({});

  const [checkoutStep, setCheckoutStep] = useState("phone");
  const [phone, setPhone] = useState(prefilledPhone);
  const [customer, setCustomer] = useState(null); // { customerId, name, addresses } | null
  const [selectedAddressId, setSelectedAddressId] = useState(null);
  const [newAddress, setNewAddress] = useState({ label: "", street: "", number: "", complement: "", neighborhood: "", city: "", reference: "" });
  const [payment, setPayment] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [order, setOrder] = useState(null); // resultado de createPublicOrder
  const [statusPoll, setStatusPoll] = useState(null); // { orderStatus, itemsStatus, deliveryStatus }

  useEffect(() => {
    api
      .getPublicMenu()
      .then((m) => {
        setMenu(m);
        setActiveCategory(m.categories[0]?.id ?? null);
      })
      .catch((e) => setMenuError(e.message));
  }, []);

  const allProducts = menu?.categories.flatMap((c) => c.products.map((p) => ({ ...p, categoryName: c.name }))) ?? [];
  const cartItems = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => ({ ...allProducts.find((p) => p.id === id), quantity: qty }));
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const itemCount = cartItems.reduce((s, i) => s + i.quantity, 0);

  function addToCart(id) {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  }
  function removeFromCart(id) {
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) - 1) }));
  }
  function scrollToCategory(id) {
    setActiveCategory(id);
    scrollRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const result = await api.lookupPublicCustomer(phoneToLookup);
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

  async function submitOrder() {
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const created = await api.createPublicOrder({
        channel: viaWhatsApp ? "whatsapp" : "web",
        customerPhone: phone,
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
        items: cartItems.map((i) => ({ productId: i.id, quantity: i.quantity })),
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
      const s = await api.getPublicOrderStatus(order.orderId);
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

  if (menuError) {
    return (
      <div className="min-h-screen bg-[#f5f1ea] flex items-center justify-center p-6">
        <p className="text-[#211b19] text-sm text-center">Não foi possível carregar o cardápio agora. Tente de novo em alguns minutos.</p>
      </div>
    );
  }
  if (!menu) {
    return <div className="min-h-screen bg-[#f5f1ea]" />;
  }

  return (
    <div className="min-h-screen bg-[#f5f1ea] font-sans text-[#211b19] flex justify-center">
      <div className="w-full max-w-[430px] min-h-screen bg-white relative flex flex-col">
        {screen === "menu" && (
          <MenuScreen
            menu={menu}
            viaWhatsApp={viaWhatsApp}
            activeCategory={activeCategory}
            scrollToCategory={scrollToCategory}
            scrollRefs={scrollRefs}
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
            addToCart={addToCart}
            removeFromCart={removeFromCart}
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
            onBack={() => setScreen("cart")}
            onSubmit={submitOrder}
            submitting={submitting}
            error={checkoutError}
          />
        )}

        {screen === "confirmation" && order && (
          <ConfirmationScreen order={order} status={statusPoll} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function MenuScreen({ menu, viaWhatsApp, activeCategory, scrollToCategory, scrollRefs, cart, addToCart, removeFromCart, itemCount, subtotal, onOpenCart }) {
  return (
    <>
      <div className="px-5 pt-6 pb-4 border-b border-black/8">
        <div className="flex items-center justify-between">
          <p className="text-[11px] tracking-[0.18em] uppercase text-[#e8a33d] font-semibold">Pedido para entrega</p>
          {viaWhatsApp && <span className="text-[10.5px] font-semibold bg-[#25D366]/15 text-[#1a8a49] px-2 py-0.5 rounded-full">Via WhatsApp</span>}
        </div>
        <h1 className="text-2xl font-extrabold tracking-tight mt-1">Cardápio</h1>
      </div>

      <div className="flex gap-2 px-5 py-3 overflow-x-auto sticky top-0 bg-white/95 backdrop-blur z-10 border-b border-black/5">
        {menu.categories.map((c) => (
          <button
            key={c.id}
            onClick={() => scrollToCategory(c.id)}
            className={`shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
              activeCategory === c.id ? "bg-[#e8a33d] text-[#211b19]" : "bg-black/[0.025] text-[#211b19] border border-black/8"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-28">
        {menu.categories.map((c) => (
          <div key={c.id} ref={(el) => (scrollRefs.current[c.id] = el)} className="pt-5">
            <h2 className="text-[13px] font-bold uppercase tracking-wide text-[#8a7c6d] mb-2">{c.name}</h2>
            {c.products.map((p) => {
                const qty = cart[p.id] ?? 0;
                return (
                  <div key={p.id} className="flex items-center justify-between py-3 border-b border-black/5 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {p.imagePath && (
                        <img src={p.imagePath} alt={p.name} className="w-14 h-14 rounded-lg object-cover shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-[14.5px] font-semibold leading-tight">{p.name}</p>
                        {p.description && <p className="text-[11.5px] text-[#8a7c6d] leading-snug mt-0.5 line-clamp-2">{p.description}</p>}
                        <p className="text-[13.5px] text-[#e8a33d] font-semibold mt-1">{money(p.price)}</p>
                      </div>
                    </div>
                  {qty === 0 ? (
                    <button onClick={() => addToCart(p.id)} className="shrink-0 w-9 h-9 rounded-full bg-[#e8a33d] flex items-center justify-center" aria-label={`Adicionar ${p.name}`}>
                      <Plus size={17} className="text-[#211b19]" />
                    </button>
                  ) : (
                    <div className="shrink-0 flex items-center gap-2.5 bg-black/[0.025] border border-black/8 rounded-full px-1 py-1">
                      <button onClick={() => removeFromCart(p.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Diminuir quantidade">
                        <Minus size={14} />
                      </button>
                      <span className="text-[13.5px] font-semibold w-4 text-center">{qty}</span>
                      <button onClick={() => addToCart(p.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Aumentar quantidade">
                        <Plus size={14} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {itemCount > 0 && (
        <button onClick={onOpenCart} className="absolute bottom-5 left-5 right-5 bg-[#e8a33d] text-[#211b19] rounded-xl h-13 py-3.5 px-4 flex items-center justify-between font-semibold shadow-lg">
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
function CartScreen({ items, subtotal, addToCart, removeFromCart, onBack, onCheckout }) {
  return (
    <>
      <TopBar title="Seu carrinho" onBack={onBack} />
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {items.length === 0 ? (
          <p className="text-[#8a7c6d] text-sm mt-8 text-center">Carrinho vazio.</p>
        ) : (
          items.map((it) => (
            <div key={it.id} className="flex items-center justify-between py-3 border-b border-black/5 gap-3">
              <div className="min-w-0">
                <p className="text-[14.5px] font-semibold">{it.name}</p>
                <p className="text-[13px] text-[#8a7c6d] mt-0.5">{money(it.price)} cada</p>
              </div>
              <div className="shrink-0 flex items-center gap-2.5 bg-black/[0.025] border border-black/8 rounded-full px-1 py-1">
                <button onClick={() => removeFromCart(it.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Diminuir quantidade">
                  <Minus size={14} />
                </button>
                <span className="text-[13.5px] font-semibold w-4 text-center">{it.quantity}</span>
                <button onClick={() => addToCart(it.id)} className="w-7 h-7 flex items-center justify-center" aria-label="Aumentar quantidade">
                  <Plus size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {items.length > 0 && (
        <div className="px-5 pb-6 pt-3 border-t border-black/8">
          <p className="text-[11.5px] text-[#8a7c6d] mb-3">A taxa de entrega é calculada no próximo passo.</p>
          <button onClick={onCheckout} className="w-full bg-[#e8a33d] text-[#211b19] rounded-xl h-12 font-semibold text-[14.5px]">
            Continuar · {money(subtotal)}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function CheckoutScreen(props) {
  const { step, setStep, phone, setPhone, onLookup, customer, selectedAddressId, setSelectedAddressId, newAddress, setNewAddress, payment, setPayment, items, subtotal, onBack, onSubmit, submitting, error } = props;
  const titles = { phone: "Identificação", address: "Endereço de entrega", "new-address": "Endereço de entrega", payment: "Pagamento", review: "Confirmar pedido" };

  return (
    <>
      <TopBar
        title={titles[step]}
        onBack={() => {
          if (step === "phone") onBack();
          else if (step === "address" || step === "new-address") setStep("phone");
          else if (step === "payment") setStep(customer?.addresses?.length ? "address" : "new-address");
          else setStep("payment");
        }}
      />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-[13px] bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 mb-4">
            <AlertTriangle size={14} className="shrink-0" /> {error}
          </div>
        )}

        {step === "phone" && (
          <div>
            <p className="text-[13.5px] text-[#8a7c6d] mb-3">Pra identificar seu pedido e endereços salvos, informe seu telefone.</p>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(11) 99999-0000"
              inputMode="tel"
              className="w-full bg-black/[0.025] border border-black/12 rounded-lg px-4 h-12 text-[15px] outline-none focus:border-[#e8a33d]"
            />
          </div>
        )}

        {step === "address" && (
          <div className="space-y-2.5">
            {customer?.addresses.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedAddressId(a.id)}
                className={`w-full text-left rounded-lg border p-3.5 flex items-start gap-3 ${selectedAddressId === a.id ? "border-[#e8a33d] bg-[#e8a33d]/10" : "border-black/12 bg-black/[0.025]"}`}
              >
                <MapPin size={17} className="mt-0.5 shrink-0 text-[#e8a33d]" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold">{a.label || "Endereço"}</p>
                  <p className="text-[12.5px] text-[#8a7c6d] mt-0.5">{formatAddress(a)}</p>
                </div>
                {selectedAddressId === a.id && <Check size={17} className="ml-auto shrink-0 text-[#e8a33d]" />}
              </button>
            ))}
            <button onClick={() => { setSelectedAddressId(null); setStep("new-address"); }} className="w-full text-left rounded-lg border border-dashed border-black/20 p-3.5 text-[13.5px] text-[#8a7c6d]">
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
            {PAYMENT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPayment(opt.value)}
                className={`w-full text-left rounded-lg border p-3.5 flex items-center justify-between ${payment === opt.value ? "border-[#e8a33d] bg-[#e8a33d]/10" : "border-black/12 bg-black/[0.025]"}`}
              >
                <span className="text-[14px] font-medium">{opt.label}</span>
                {payment === opt.value && <Check size={17} className="text-[#e8a33d]" />}
              </button>
            ))}
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="rounded-lg bg-black/[0.025] border border-black/8 p-4 mb-4">
              {items.map((it) => (
                <div key={it.id} className="flex justify-between text-[13.5px] py-1">
                  <span>{it.quantity}x {it.name}</span>
                  <span className="text-[#8a7c6d]">{money(it.price * it.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-black/8 mt-2 pt-2 flex justify-between text-[14px] font-bold">
                <span>Subtotal</span><span>{money(subtotal)}</span>
              </div>
              <p className="text-[11.5px] text-[#8a7c6d] mt-1">+ taxa de entrega, calculada na confirmação</p>
            </div>
            <div className="rounded-lg bg-black/[0.025] border border-black/8 p-4 mb-4 space-y-1.5">
              <div className="flex items-start gap-2 text-[13.5px]">
                <MapPin size={15} className="mt-0.5 shrink-0 text-[#e8a33d]" />
                <span>{selectedAddressId ? formatAddress(customer.addresses.find((a) => a.id === selectedAddressId)) : formatAddress(newAddress)}</span>
              </div>
              <p className="text-[13.5px] text-[#8a7c6d] pl-5.5 ml-0.5">Pagamento: {PAYMENT_OPTIONS.find((o) => o.value === payment)?.label}</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 pb-6 pt-3 border-t border-black/8">
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
          className="w-full bg-[#e8a33d] text-[#211b19] rounded-xl h-12 font-semibold text-[14.5px] disabled:opacity-40"
        >
          {submitting ? "Enviando…" : step === "review" ? "Confirmar pedido" : "Continuar"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function ConfirmationScreen({ order, status }) {
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
        <div className="w-14 h-14 rounded-full bg-[#e8a33d]/15 border border-[#e8a33d]/40 flex items-center justify-center mx-auto mb-4">
          <Check size={26} className="text-[#e8a33d]" />
        </div>
        <h1 className="text-xl font-extrabold">Pedido confirmado!</h1>
        <p className="text-[13.5px] text-[#8a7c6d] mt-1">Tempo estimado: {order.estimatedMinutes} min · Total {money(order.total)}</p>
      </div>

      {failed && (
        <div className="flex items-center gap-2 text-red-600 text-[13px] bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 mb-6">
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
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors duration-500 ${done ? "bg-[#e8a33d] text-[#211b19]" : "bg-black/[0.03] text-[#8a7c6d] border border-black/12"}`}>
                  <Icon size={16} />
                </div>
                {!isLast && <div className={`w-0.5 flex-1 min-h-[28px] transition-colors duration-500 ${stageIndex > i ? "bg-[#e8a33d]" : "bg-black/10"}`} />}
              </div>
              <div className="pb-7 pt-1.5">
                <p className={`text-[14px] font-medium transition-colors duration-500 ${done ? "text-[#211b19]" : "text-[#8a7c6d]"}`}>{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-[11.5px] text-[#8a7c6d] mt-2">Esta tela atualiza sozinha — não precisa dar refresh.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TopBar({ title, onBack }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-black/8 shrink-0">
      <button onClick={onBack} className="w-8 h-8 -ml-1.5 flex items-center justify-center" aria-label="Voltar">
        <ChevronLeft size={22} />
      </button>
      <h1 className="text-[15.5px] font-semibold">{title}</h1>
    </div>
  );
}
function Field({ label, value, onChange, placeholder, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[12px] text-[#8a7c6d] mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-black/[0.025] border border-black/12 rounded-lg px-3.5 h-11 text-[14px] outline-none focus:border-[#e8a33d]"
      />
    </label>
  );
}
