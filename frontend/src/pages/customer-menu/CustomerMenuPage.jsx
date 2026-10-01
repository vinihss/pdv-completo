import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, MapPin, Check, AlertTriangle, X, PartyPopper, Pencil, User, CreditCard } from "lucide-react";
import { getStoreInfo } from "@/entities/store";
import { getPublicCart, savePublicCart, clearPublicCart } from "@/entities/cart";
import { lookupPublicCustomer, saveProfileLocal, loadProfileLocal } from "@/entities/customer";
import { createPublicOrder, getPublicOrderStatus, getActivePublicOrder, cancelPublicOrder } from "@/entities/order";
import { getPublicMenu } from "@/entities/product";
import { fetchAddressByCep } from "@/shared/api/cep";
import { usePublicRealtime } from "@/shared/hooks";
import { Modal } from "@/shared/components";
import { applyBrandPrimary, variationsText, formatBRL } from "@/shared/lib";
import { VariationModal } from "@/entities/product";
import { lineKey, toServerLine, variationGroups, hasVariations, missingRequiredGroups, saveCartLocal, loadCartLocal, clearCartLocal } from "@/entities/cart";
import MenuScreen from "./components/MenuScreen.jsx";
import CartLine from "./components/CartLine.jsx";
import { assetUrl } from "@/shared/lib/server";

function formatAddress(a) {
  if (!a) return "";
  // Mesma ordem do formatAddress do backend (customer-address.usecases.ts), para
  // o cliente ler na revisão exatamente o que o entregador vai ler na comanda.
  return `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""} · ${a.neighborhood}, ${a.city}${a.state ? ` - ${a.state}` : ""}`;
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
function maskCep(raw) {
  const d = digitsOnly(raw).slice(0, 8);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}
function maskState(raw) {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
}

// Uma única definição do endereço vazio. Antes existiam duas (o useState e o
// resetOrder) e elas já divergiram uma vez — o reset não tinha `cep`.
const EMPTY_ADDRESS = {
  label: "",
  cep: "",
  street: "",
  number: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
  reference: "",
};

const PAYMENT_OPTIONS = [
  { value: "cash", label: "Dinheiro" },
  { value: "card", label: "Cartão na entrega" },
  { value: "pix", label: "Pix" },
];

// Stages em que o cliente ainda pode cancelar (espelha isCustomerCancellable
// do backend — o backend valida de novo, isto é só pra exibir o botão).
const CANCELLABLE_STAGES = ["received", "preparing", "ready", "failed"];

/**
 * Rota pública real (/pedido), sem AuthProvider/login — consome
 * /public/* no backend. Substitui o protótipo solto que existia antes.
 *
 * Continuação do pedido sem localStorage (docs/05 §"Continuação do pedido"):
 * - Rascunho do carrinho no servidor (customer_cart, chaveado por telefone,
 *   TTL 24h) — quem fecha a aba no meio do checkout retoma pelo mesmo link.
 *   Sem telefone (web direta) o carrinho vive só em memória: perda
 *   intencional, o custo de pedir o telefone antes do checkout é maior.
 * - Pedido em andamento por telefone vira banner "Ver status" na página.
 * - Acompanhamento: WebSocket público /realtime/public na sala
 *   order:<id> (o UUID é a "senha" de fato, mesmo modelo de confiança do
 *   GET de status) com polling de 4s como fallback — o WS é otimização, o
 *   polling é quem garante consistência.
 * - Etapas vêm de `customerStage`/`timeline` do backend — a UI não tem
 *   máquina de estados própria, só renderiza o stage canônico.
 *
 * Tema acompanha o app do sistema (dark, palette stone) e usa a cor da marca
 * como acento (--brand-accent / rampa amber sobreposta por applyBrandPrimary).
 */
export default function CustomerMenuPage() {
  const [searchParams] = useSearchParams();
  const viaWhatsApp = searchParams.get("via") === "whatsapp";
  const prefilledPhone = searchParams.get("phone") ?? "";
  // Retomada direta de um pedido (link do bot / confirmação salva).
  const orderParam = searchParams.get("order");

  const [menu, setMenu] = useState(null);
  const [menuError, setMenuError] = useState(null);
  const [storeInfo, setStoreInfo] = useState(null); // /store-info (logo, nome)
  const [deliveryAvailable, setDeliveryAvailable] = useState(null); // null = checando
  const [screen, setScreen] = useState("menu");
  // { [lineKey]: { productId, quantity, selectedVariations, notes } }
  const [cart, setCart] = useState({});
  const [searchTerm, setSearchTerm] = useState("");
  // Layout de loja: as pills não filtram, elas rolam até a seção. O estado
  // aqui é só para acender a pill da seção que está em tela.
  const [activeSection, setActiveSection] = useState(null);
  // Barra de busca só aparece depois de rolar (e some quando o topo volta).
  const [scrolled, setScrolled] = useState(false);
  const [canScroll, setCanScroll] = useState(false);
  // No desktop o scroll acontece dentro da coluna esquerda (não na window),
  // então o listener precisa dos dois alvos.
  const menuScrollRef = useRef(null);
  // Produto com variação aguardando escolha no modal (null = fechado).
  const [pendingProduct, setPendingProduct] = useState(null);
  // Chave da linha em edição (null = incluindo item novo). Existe porque uma
  // linha resgatada do carrinho do servidor pode ter vindo sem opção
  // obrigatória — o cliente precisa conseguir corrigir antes do checkout.
  const [pendingLineKey, setPendingLineKey] = useState(null);

  const [checkoutStep, setCheckoutStep] = useState("phone");
  // O telefone vem do `?phone=` do link do bot; na web direta sai do cache de
  // perfil (entities/customer/model/profileStorage.js) — cliente que já pediu
  // uma vez não digita o número de novo.
  const [phone, setPhone] = useState(() => maskPhone(prefilledPhone) || maskPhone(loadProfileLocal().phone));
  const [customer, setCustomer] = useState(null); // { customerId, name, addresses } | null
  const [selectedAddressId, setSelectedAddressId] = useState(null);
  // `cep` alimenta a busca do ViaCEP e vai no payload — o backend persiste
  // (migration 0005) e o devolve no lookup de endereços. `state` (UF) entrou
  // junto da migration 0006, pelo mesmo caminho.
  const [newAddress, setNewAddress] = useState(() => loadProfileLocal().address ?? EMPTY_ADDRESS);
  const [payment, setPayment] = useState(null);
  // Observação do pedido inteiro (a KitchenDisplay mostra na comanda, a bobina
  // imprime). Distinta das observações por item, que já existem no carrinho.
  const [orderNotes, setOrderNotes] = useState("");
  // `maxKm` da faixa de distância escolhida na tela de endereço. Só alimenta a
  // previsão de entrega (domain/delivery-eta.ts) — o frete em si continua
  // sendo a taxa fixa de store_settings, como no §04.
  const [deliveryZoneKm, setDeliveryZoneKm] = useState(null);
  // Só aparece (e só é enviado) quando o pagamento é dinheiro. Guarda o que o
  // cliente vai entregar na mão — não o troco: o entregador subtrai o total e
  // o backend valida que o valor entregue cobre a compra.
  const [cashReceived, setCashReceived] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [order, setOrder] = useState(null); // resultado de createPublicOrder | { orderId } na retomada
  const [statusPoll, setStatusPoll] = useState(null); // { orderStatus, customerStage, timeline, total, ... }
  const [activeOrder, setActiveOrder] = useState(null); // { orderId, customerStage, total }
  const [cancelError, setCancelError] = useState(null);

  // Telefone reflete em ref pra persistir o carrinho mesmo em callbacks
  // criados antes da digitação (debounce de 800ms).
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // Mesma técnica para o nome e o endereço: o save do perfil é debounced e
  // roda fora do ciclo de render, então precisa ler o valor corrente.
  const customerRef = useRef(customer);
  customerRef.current = customer;
  const newAddressRef = useRef(newAddress);
  newAddressRef.current = newAddress;
  // Nome e pagamento também entram no save debounced do perfil — refs para
  // ler o valor corrente de dentro do timer, que roda fora do render.
  const nameRef = useRef(newAddress.customerName ?? "");
  nameRef.current = newAddress.customerName ?? customer?.name ?? "";
  const paymentRef = useRef(payment);
  paymentRef.current = payment;

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
        // Telefone do link do bot tem prioridade, mas o rascunho do servidor é
        // chaveado por telefone: sem ele, quem já pediu uma vez e volta pelo
        // link simples perde os itens que tinha deixado no rascunho.
        hydrateCartFromServer(m, digitsOnly(prefilledPhone) || digitsOnly(phoneRef.current));
        hydrateCartFromLocal(m);
      })
      .catch((e) => setMenuError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retomada por ?order=<id> — vai direto pro acompanhamento (o GET de
  // status traz total/estimativa/timeline, então não precisa do payload de
  // criação).
  useEffect(() => {
    if (!orderParam) return;
    setOrder({ orderId: orderParam });
    setScreen("confirmation");
  }, [orderParam]);

  // Pedido em andamento pra banner (superfície de leitura por telefone, como
  // o lookup de cliente — mesma exposição).
  useEffect(() => {
    const p = digitsOnly(prefilledPhone);
    if (!p) return;
    getActivePublicOrder(p)
      .then((r) => setActiveOrder(r))
      .catch(() => {});
  }, [prefilledPhone]);

  const allProducts = menu?.categories.flatMap((c) => c.products.map((p) => ({ ...p, categoryName: c.name }))) ?? [];
  const productById = new Map(allProducts.map((p) => [p.id, p]));
  // Linha do carrinho + dados do produto do cardápio atual. Produto que
  // saiu do menu é descartado da visualização (o submit voltaria 422).
  const cartItems = Object.entries(cart)
    .filter(([, l]) => l.quantity > 0)
    .map(([key, l]) => ({ ...(productById.get(l.productId) ?? {}), key, ...l }))
    .filter((it) => it.id);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const itemCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const deliveryFee = storeInfo?.deliveryFee ?? 0;
  const deliveryZones = useMemo(() => buildDeliveryZones(storeInfo), [storeInfo]);
  const paymentOptions = PAYMENT_OPTIONS.filter(
    (o) => !storeInfo?.enabledPaymentMethods || storeInfo.enabledPaymentMethods.includes(o.value)
  );
  // O que a tela de confirmação mostra (e oferece editar). O nome editado tem
  // precedência sobre o cadastro — é o mesmo valor que vai no payload.
  const reviewName = newAddress.customerName?.trim() || customer?.name || "";
  const reviewPaymentLabel = paymentOptions.find((o) => o.value === payment)?.label ?? "";

  // ---------- carrinho server-side ----------

  // Debounce: cada mutação de linha agenda um PUT. Best-effort — falha de
  // rede aqui não bloqueia o cliente (o submit sempre reenvia o carrinho
  // inteiro e valida de novo no backend).
  const saveTimer = useRef(null);
  const scheduleCartSave = useCallback((nextCart) => {
    const p = digitsOnly(phoneRef.current);
    if (!p) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      savePublicCart(p, Object.values(nextCart).filter((l) => l.quantity > 0).map(toServerLine)).catch(() => {});
    }, 800);
  }, []);
  const flushCartSave = useCallback((nextCart) => {
    const p = digitsOnly(phoneRef.current);
    if (!p) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    savePublicCart(p, Object.values(nextCart).filter((l) => l.quantity > 0).map(toServerLine)).catch(() => {});
  }, []);

  function hydrateCartFromServer(m, p) {
    if (!p) return;
    getPublicCart(p)
      .then(({ items }) => {
        if (!Array.isArray(items) || items.length === 0) return;
        const menuIds = new Set(m.categories.flatMap((c) => c.products.map((prod) => prod.id)));
        const next = {};
        for (const it of items) {
          if (!it?.productId || !menuIds.has(it.productId)) continue; // saiu do menu
          const quantity = Math.max(1, Math.min(99, Number(it.quantity) || 1));
          const variations = it.selectedVariations ?? {};
          next[lineKey(it.productId, variations)] = {
            productId: it.productId,
            quantity,
            selectedVariations: variations,
            notes: it.notes ?? "",
          };
        }
        if (Object.keys(next).length > 0) setCart(next);
      })
      .catch(() => {});
  }

  function hydrateCartFromLocal(m) {
    const items = loadCartLocal();
    if (!items || items.length === 0) return;
    const menuIds = new Set(m.categories.flatMap((c) => c.products.map((prod) => prod.id)));
    const next = {};
    for (const it of items) {
      if (!it?.productId || !menuIds.has(it.productId)) continue;
      const quantity = Math.max(1, Math.min(99, Number(it.quantity) || 1));
      const variations = it.selectedVariations ?? {};
      next[lineKey(it.productId, variations)] = {
        productId: it.productId,
        quantity,
        selectedVariations: variations,
        notes: it.notes ?? "",
      };
    }
    if (Object.keys(next).length > 0) setCart(next);
  }

  // ---------- mutações do carrinho ----------

  // Nenhum produto entra no carrinho em um toque: todo clique abre a ficha
  // completa (foto, descrição, variações, quantidade) — é onde a escolha
  // acontece, e vale para produto sem variação também. A escolha vai pra linha
  // com a própria chave (mesmo produto com "Ponto da carne" diferente são duas
  // linhas).
  function addToCart(product) {
    setPendingProduct(product);
  }

  // Reabre o modal já com a escolha atual (edição de linha).
  function editLine(it) {
    setPendingProduct(productById.get(it.productId) ?? { id: it.productId, name: it.name, price: it.price });
    setPendingLineKey(it.key);
  }

  function applyLineEdit(product, lineKeyToEdit, selectedVariations, notes) {
    const current = cart[lineKeyToEdit];
    if (!current) return;
    const nextKey = lineKey(product.id, selectedVariations);
    const next = { ...cart };
    if (nextKey === lineKeyToEdit) {
      next[lineKeyToEdit] = { ...current, selectedVariations, notes: notes ?? current.notes };
    } else {
      // Trocar a variação move a quantidade pra linha destino (somando com o
      // que já existia lá) e remove a antiga — nada se perde.
      const target = next[nextKey];
      next[nextKey] = {
        productId: product.id,
        quantity: current.quantity + (target?.quantity ?? 0),
        selectedVariations,
        notes: notes ?? current.notes,
      };
      delete next[lineKeyToEdit];
    }
    setCart(next);
    scheduleCartSave(next);
    saveCartLocal(Object.values(next).filter((l) => l.quantity > 0).map(toServerLine));
  }

  function addLine(product, selectedVariations, notes, quantity = 1) {
    const key = lineKey(product.id, selectedVariations);
    const existing = cart[key];
    const next = {
      ...cart,
      [key]: {
        productId: product.id,
        quantity: (existing?.quantity ?? 0) + quantity,
        selectedVariations,
        // Observação digitada no modal só vira a observação da linha quando é
        // a primeira delas — depois a edição é pela tela do carrinho, que já
        // mostra a linha com a variação.
        notes: existing?.notes ?? notes ?? "",
      },
    };
    setCart(next);
    scheduleCartSave(next);
    saveCartLocal(Object.values(next).filter((l) => l.quantity > 0).map(toServerLine));
  }
  function addToCartLine(key) {
    const line = cart[key];
    if (!line) return;
    const next = { ...cart, [key]: { ...line, quantity: line.quantity + 1 } };
    setCart(next);
    scheduleCartSave(next);
    saveCartLocal(Object.values(next).filter((l) => l.quantity > 0).map(toServerLine));
  }
  function removeFromCartLine(key) {
    const line = cart[key];
    if (!line) return;
    const nextQty = line.quantity - 1;
    let next;
    if (nextQty <= 0) {
      next = { ...cart };
      delete next[key];
    } else {
      next = { ...cart, [key]: { ...line, quantity: nextQty } };
    }
    setCart(next);
    scheduleCartSave(next);
    saveCartLocal(Object.values(next).filter((l) => l.quantity > 0).map(toServerLine));
  }
  function changeNotes(key, text) {
    const line = cart[key];
    if (!line) return;
    const next = { ...cart, [key]: { ...line, notes: text } };
    setCart(next);
    scheduleCartSave(next);
    saveCartLocal(Object.values(next).filter((l) => l.quantity > 0).map(toServerLine));
  }

  // Barra de busca: fica sempre visível se o cardápio não tem o que rolar (senão
  // o cliente nunca poderia buscar) e some quando ela está no topo.
  const showBar = !canScroll || scrolled || searchTerm.trim().length > 0;

  // Seção em tela = a última que passou da linha de corte. Usado só para
  // acender a pill; um rAF evita recalcular a cada pixel de scroll.
  const rafRef = useRef(0);
  // No desktop o scroll é da coluna esquerda; no celular é o documento (a
  // div do menu é display:contents, então clientHeight é 0 e serve de sinal
  // para não usá-la como fonte de scroll).
  const scrollSource = () => {
    const el = menuScrollRef.current;
    return el && el.clientHeight > 0 ? el : document.scrollingElement ?? document.documentElement;
  };
  const syncScrollState = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrolled(scrollSource().scrollTop > 40);
      const sections = Array.from(document.querySelectorAll("[data-section]"));
      let current = sections[0]?.dataset.section ?? null;
      for (const node of sections) {
        if (node.getBoundingClientRect().top - 130 <= 0) current = node.dataset.section;
      }
      setActiveSection(current);
    });
  }, []);

  useEffect(() => {
    const measure = () => {
      const src = scrollSource();
      // Sem rolagem não há "rolou a página" — a barra fica sempre visível.
      setCanScroll(src.scrollHeight > src.clientHeight + 8);
      syncScrollState();
    };
    measure();
    // Depois que as imagens carregam, o cardápio cresce e a página passa a
    // rolar — medir cedo demais esconderia a barra para sempre.
    const timer = setTimeout(measure, 500);
    window.addEventListener("resize", measure);
    const scrollEl = scrollSource();
    scrollEl.addEventListener("scroll", syncScrollState, { passive: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", measure);
      scrollEl.removeEventListener("scroll", syncScrollState);
    };
  }, [menu, screen, syncScrollState]);

  function selectSection(id) {
    setActiveSection(id);
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function startCheckout() {
    setScreen("checkout");
    setCheckoutError(null);
    // Garante o rascunho salvo antes de sair do carrinho (não espera o debounce).
    flushCartSave(cart);
    if (viaWhatsApp && prefilledPhone) {
      await runLookup(prefilledPhone);
      return;
    }
    // Cliente recorrente: o perfil já tem telefone, endereço e forma de
    // pagamento, então as três telas de coleta viram ritual. Pula direto para
    // a revisão — onde nome, endereço e pagamento aparecem editáveis, e é
    // exatamente aí que o cliente quer conferir antes de confirmar.
    //
    // O `?phone=` do link do bot tem prioridade: é a identidade do rascunho do
    // servidor, e um cliente que veio pelo WhatsApp precisa do lookup para o
    // endereço salvo aparecer.
    const cached = loadProfileLocal();
    if (!prefilledPhone && hasCompleteCheckoutData(cached, addressForReview())) {
      setCustomer(null);
      setSelectedAddressId(null);
      setPayment(cached.payment);
      setCheckoutStep("review");
    } else {
      setCheckoutStep("phone");
    }
  }

  /** Endereço que o pedido usaria agora — o salvo selecionado ou o digitado. */
  function addressForReview() {
    if (selectedAddressId && customer?.addresses) {
      return customer.addresses.find((a) => a.id === selectedAddressId) ?? null;
    }
    return newAddress;
  }

  function onPhoneChange(value) {
    setPhone(maskPhone(value));
    // Digitar o telefone passa a ser a identidade do rascunho — salva o
    // carrinho em memória sob ela (recarregar a página no meio do checkout
    // não perde os itens).
    const masked = maskPhone(value);
    if (digitsOnly(masked)) scheduleCartSave(cart);
  }

  // Telefone, nome, endereço e forma de pagamento no cache local: quem fecha a
  // aba no meio do checkout volta com tudo preenchido, e quem terminar o pedido
  // e voltar pra pedir de novo não digita nada. Best-effort, mesmo espírito do
  // rascunho.
  const profileTimer = useRef(null);
  const scheduleProfileSave = useCallback((address) => {
    if (profileTimer.current) clearTimeout(profileTimer.current);
    profileTimer.current = setTimeout(() => {
      saveProfileLocal({
        phone: phoneRef.current,
        name: nameRef.current,
        address: address ?? newAddressRef.current,
        payment: paymentRef.current,
      });
    }, 600);
  }, []);

  useEffect(() => () => { if (profileTimer.current) clearTimeout(profileTimer.current); }, []);

  async function runLookup(phoneToLookup) {
    const lookup = digitsOnly(phoneToLookup);
    if (!lookup) return;
    setSubmitting(true);
    setCheckoutError(null);
    flushCartSave(cart);
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
    setScreen("menu");
    setCheckoutStep("phone");
    setCustomer(null);
    setSelectedAddressId(null);
    // Endereço e telefone voltam do perfil, não do vazio: "pedir de novo" é o
    // caminho mais comum depois de confirmar, e recomeçar do zero seria punir o
    // cliente por ter feito o que a tela manda.
    const cached = loadProfileLocal();
    setNewAddress(cached.address ?? EMPTY_ADDRESS);
    setPhone(maskPhone(prefilledPhone) || maskPhone(cached.phone));
    // A forma de pagamento também sobrevive ao pedido: é uma escolha estável do
    // cliente, não uma decisão do pedido. Zera só se o gerente desabilitou o
    // método no meanwhile (paymentOptions não tem mais a opção).
    setPayment(paymentOptions.some((o) => o.value === cached.payment) ? cached.payment : null);
    setCashReceived("");
    setOrderNotes("");
    setOrder(null);
    setStatusPoll(null);
    setCheckoutError(null);
    setCancelError(null);
    clearCartLocal();
    const p = digitsOnly(phoneRef.current);
    if (!p) {
      setActiveOrder(null);
      return;
    }
    clearPublicCart(p).catch(() => {});
    getActivePublicOrder(p).then((r) => setActiveOrder(r)).catch(() => {});
  }

  async function submitOrder() {
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const created = await createPublicOrder({
        channel: viaWhatsApp ? "whatsapp" : "web",
        customerPhone: digitsOnly(phone),
        // O nome editado na tela de pagamento vale sobre o que está salvo no
        // cadastro: o cliente pode querer "João" e ter cadastrado "Joao
        // Ricardo da Silva". Sem edição, o do cadastro.
        customerName: newAddress.customerName?.trim() || customer?.name || "Cliente",
        addressId: selectedAddressId ?? undefined,
        newAddress: selectedAddressId
          ? undefined
          : {
              // `cep` vai junto: o backend persiste (migration 0005) e devolve
              // no lookup, então o endereço salvo do cliente já vem com ele.
              label: newAddress.label || undefined,
              cep: newAddress.cep || undefined,
              street: newAddress.street,
              number: newAddress.number,
              complement: newAddress.complement || undefined,
              neighborhood: newAddress.neighborhood,
              city: newAddress.city,
              state: newAddress.state || undefined,
              reference: newAddress.reference || undefined,
              isDefault: true,
            },
        items: cartItems.map(toServerLine),
        paymentMethodIntent: payment,
        // Só dinheiro tem troco, e só quando o cliente diz que vai entregar
        // menos que o total (ou uma nota específica). O backend valida contra
        // o total do pedido.
        ...(payment === "cash" && cashReceived.trim() ? { cashReceived: cashReceived.trim() } : {}),
        // Só vai quando tem texto: o schema rejeita string vazia, e observação
        // em branco no banco é ruído na comanda e na bobina.
        ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
        ...(deliveryZoneKm !== null ? { deliveryZoneKm } : {}),
      });
      setOrder(created);
      setScreen("confirmation");
      // Pedido criado: o rascunho cumpriu o papel, some do servidor e do cache local.
      // O PERFIL (telefone + endereço) fica de propósito — o mesmo cliente
      // voltando pra pedir outra coisa não deveria redigitar nada. É
      // clearCartLocal/clearPublicCart que limpam, não clearProfileLocal.
      clearCartLocal();
      saveProfileLocal({
        phone: digitsOnly(phone),
        name: customer?.name ?? newAddress.customerName ?? "",
        address: selectedAddressId
          ? customer?.addresses.find((a) => a.id === selectedAddressId)
          : newAddress,
        payment,
      });
      const p = digitsOnly(phone);
      if (p) clearPublicCart(p).catch(() => {});
    } catch (e) {
      setCheckoutError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelOrder(customerPhone) {
    if (!order) return;
    setSubmitting(true);
    setCancelError(null);
    try {
      await cancelPublicOrder(order.orderId, customerPhone);
      resetOrder();
    } catch (e) {
      setCancelError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Polling de status — o WS público dispara o refresh, mas quem garante
  // consistência é o poll (evento perdido no reconnect não trava a tela).
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
    if (statusPoll?.customerStage?.terminal) return;
    const t = setInterval(pollStatus, 4000);
    return () => clearInterval(t);
  }, [screen, order, pollStatus, statusPoll?.customerStage?.terminal]);

  usePublicRealtime(
    screen === "confirmation" && order ? [`order:${order.orderId}`] : [],
    useCallback((msg) => {
      if (msg.type === "customer.stage_changed") pollStatus();
    }, [pollStatus])
  );

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
    <div className="min-h-screen bg-stone-950 font-sans text-stone-50">
      {/* Coluna única em todas as larguras. O carrinho não é mais um painel
          fixo na lateral (tirar o "Seu pedido" da direita): ele vive na barra
          flutuante (canto inferior direito no desktop, barra no celular) e abre
          a tela cheia de carrinho. */}
      <div className="w-full max-w-[480px] lg:max-w-5xl mx-auto min-h-screen bg-stone-950 relative flex flex-col lg:px-8 lg:py-8">
        <div ref={menuScrollRef} className="contents lg:flex lg:flex-col lg:min-w-0 lg:overflow-y-auto lg:max-h-[calc(100vh-4rem)] lg:pr-1 scrollbar-none">
        {screen === "menu" && (
          <MenuScreen
            menu={menu}
            cart={cart}
            viaWhatsApp={viaWhatsApp}
            logoUrl={storeInfo?.logoUrl}
            merchantName={storeInfo?.merchantName}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            showBar={showBar}
            activeSection={activeSection}
            onSelectSection={selectSection}
            addToCart={addToCart}
            addToCartLine={addToCartLine}
            removeFromCartLine={removeFromCartLine}
            editLine={editLine}
            itemCount={itemCount}
            subtotal={subtotal}
            onOpenCart={() => setScreen("cart")}
            activeOrder={activeOrder}
            onOpenActiveOrder={() => {
              if (!activeOrder) return;
              setOrder({ orderId: activeOrder.orderId });
              setScreen("confirmation");
            }}
          />
        )}

        {screen === "cart" && (
          <CartScreen
            items={cartItems}
            subtotal={subtotal}
            logoUrl={storeInfo?.logoUrl}
            addToCartLine={addToCartLine}
            removeFromCartLine={removeFromCartLine}
            onNotesChange={changeNotes}
            onEditLine={editLine}
            onBack={() => setScreen("menu")}
            onCheckout={startCheckout}
          />
        )}

        {screen === "checkout" && (
          <CheckoutScreen
            step={checkoutStep}
            setStep={setCheckoutStep}
            phone={phone}
            onPhoneChange={onPhoneChange}
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
            orderNotes={orderNotes}
            setOrderNotes={setOrderNotes}
            cashReceived={cashReceived}
            setCashReceived={setCashReceived}
            addressForReview={addressForReview}
            reviewName={reviewName}
            reviewPaymentLabel={reviewPaymentLabel}
            deliveryZoneKm={deliveryZoneKm}
            setDeliveryZoneKm={setDeliveryZoneKm}
            deliveryZones={deliveryZones}
            onAddressChange={(next) => scheduleProfileSave(next)}
            onBack={() => setScreen("cart")}
            onSubmit={submitOrder}
            submitting={submitting}
            error={checkoutError}
          />
        )}

        {screen === "confirmation" && order && (
          <ConfirmationScreen
            order={order}
            status={statusPoll}
            phone={digitsOnly(phone)}
            onCancel={cancelOrder}
            onReset={resetOrder}
            submitting={submitting}
            cancelError={cancelError}
          />
        )}
        </div>
      </div>

      {pendingProduct && (
        <VariationModal
          product={pendingProduct}
          price={pendingProduct.price}
          // ficha completa (foto + quantidade) só na entrada; ao editar uma
          // linha a quantidade muda no carrinho, então o modal não repete o
          // controle.
          imagePath={pendingLineKey ? null : pendingProduct.imagePath ?? null}
          showQuantity={!pendingLineKey}
          allowNotes
          initialSelected={pendingLineKey ? cart[pendingLineKey]?.selectedVariations ?? null : null}
          initialNotes={pendingLineKey ? cart[pendingLineKey]?.notes ?? "" : ""}
          confirmLabel={pendingLineKey ? "Salvar alterações" : "Adicionar ao carrinho"}
          onClose={() => {
            setPendingProduct(null);
            setPendingLineKey(null);
          }}
          onConfirm={(selected, notes, quantity) => {
            // Rede de segurança: o modal já trava grupo obrigatório, mas se
            // ele evoluir e deixar passar, a linha não entra no carrinho.
            if (missingRequiredGroups(variationGroups(pendingProduct), selected).length > 0) return;
            if (pendingLineKey) applyLineEdit(pendingProduct, pendingLineKey, selected, notes);
            else addLine(pendingProduct, selected, notes, quantity);
            setPendingProduct(null);
            setPendingLineKey(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function CartScreen({ items, subtotal, logoUrl, addToCartLine, removeFromCartLine, onNotesChange, onEditLine, onBack, onCheckout }) {
  const [openNote, setOpenNote] = useState(null);
  return (
    <>
      <TopBar title="Seu carrinho" onBack={onBack} logoUrl={logoUrl} />
      <div className="flex-1 overflow-y-auto px-5 py-4 max-w-xl mx-auto w-full">
        {items.length === 0 ? (
          <p className="text-stone-500 text-sm mt-8 text-center">Carrinho vazio.</p>
        ) : (
          items.map((it) => (
            <CartLine
              key={it.key}
              it={it}
              addToCartLine={addToCartLine}
              removeFromCartLine={removeFromCartLine}
              onNotesChange={onNotesChange}
              openNote={openNote}
              setOpenNote={setOpenNote}
              onEditLine={onEditLine}
              hasVariations={hasVariations(it)}
            />
          ))
        )}
      </div>
      {items.length > 0 && (
        <div className="px-5 pb-6 pt-3 border-t border-stone-800 max-w-xl mx-auto w-full">
          <p className="text-[11.5px] text-stone-500 mb-3">A taxa de entrega é calculada no próximo passo.</p>
          <button onClick={onCheckout} className="w-full bg-amber-500 text-[var(--brand-accent-foreground)] rounded-xl h-12 font-semibold text-[14.5px]">
            Continuar · {formatBRL(subtotal)}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Previsão de entrega (texto) e seletor de faixa de distância.

/**
 * "Previsão de entrega: 40 a 50 min" enquanto o pedido está na cozinha, e
 * "Previsão de entrega: até 19:52" depois que saiu para entrega — momento em que
 * a janela deixa de ser estimativa e passa a ser contagem do horário real de
 * despacho (vem em `deliverBy`, já em ISO do servidor).
 *
 *hora cheia não sai: se o backend não mandou janela (pedido antigo, ou o GET de
 * status respondeu antes do novo campo existir), o texto some em vez de virar
 * "undefined min".
 */
function etaLine(window, deliverBy) {
  if (deliverBy) {
    const at = new Date(deliverBy);
    if (!Number.isNaN(at.getTime())) {
      return `Previsão de entrega: até ${at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    }
  }
  if (window?.min && window?.max) {
    const range = window.min === window.max ? `${window.min} min` : `${window.min} a ${window.max} min`;
    return `Previsão de entrega: ${range}`;
  }
  return "";
}

/**
 * Faixas de distância vindas da tabela de frete da loja (`/store-info` expõe
 * `deliveryFeeTiers`). É a mesma lista que decide o preço e o raio, então o
 * cliente vê as faixas que o balcão realmente usa — e é dela que sai a previsão
 * de entrega (domain/delivery-eta.ts).
 */
function buildDeliveryZones(storeInfo) {
  const tiers = Array.isArray(storeInfo?.deliveryFeeTiers) ? storeInfo.deliveryFeeTiers : [];
  const prep = storeInfo?.deliveryPrepMinutes ?? 40;
  const perKm = storeInfo?.minutesPerKm ?? 2;
  return tiers
    .filter((t) => Number.isFinite(t?.maxKm) && t.maxKm > 0)
    .map((t, i, arr) => ({
      maxKm: t.maxKm,
      label: i === 0 ? `Até ${t.maxKm} km` : `${arr[i - 1].maxKm} a ${t.maxKm} km`,
      minutes: Math.max(5, Math.ceil(t.maxKm * perKm)),
    }))
    .map((z) => ({ ...z, estimate: `≈ ${z.minutes + prep} min` }));
}

function zoneLabel(zoneKm, zones) {
  const zone = zones.find((z) => z.maxKm === zoneKm);
  return zone ? `${zone.label} · ${zone.estimate}` : "a definir";
}

function ZoneSelector({ zones, value, onChange }) {
  if (!zones || zones.length === 0) return null;
  return (
    <div className="pt-1">
      <div className="text-[12.5px] font-semibold text-stone-300 mb-1.5">
        Distância aproximada <span className="text-stone-500 font-normal">(opcional)</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {zones.map((z) => (
          <button
            key={z.maxKm}
            type="button"
            onClick={() => onChange(value === z.maxKm ? null : z.maxKm)}
            className={`rounded-lg border px-3 py-2.5 text-left ${value === z.maxKm ? "border-amber-500 bg-amber-500/10" : "border-stone-800 bg-stone-900"}`}
          >
            <span className="block text-[13px] font-medium text-stone-100">{z.label}</span>
            <span className="block text-[11.5px] text-stone-500">{z.estimate}</span>
          </button>
        ))}
      </div>
      <p className="text-[11.5px] text-stone-600 mt-1.5">
        Usamos essa informação para estimar a hora de entrega. O frete não muda em relação ao que está acima.
      </p>
    </div>
  );
}

/**
 * Uma linha clicável do resumo da revisão (nome/endereço/pagamento).
 * Sem isto, corrigir um dado só no pedido de delivery exigiria voltar três
 * telas — e o cliente recorrente cai direto na revisão justamente quando já
 * confia no fluxo e só quer bater o olho.
 */
function EditRow({ icon, label, value, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-2.5 rounded-lg px-2 py-2 -mx-2 hover:bg-stone-800/60 transition-colors"
    >
      <span className="mt-0.5 shrink-0 text-amber-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-wide text-stone-500">{label}</span>
        <span className="block text-[13.5px] text-stone-100 leading-snug break-words">{value || "—"}</span>
      </span>
      <Pencil size={14} className="mt-0.5 shrink-0 text-stone-500" />
    </button>
  );
}

/**
 * Troco a partir do que o cliente disse que vai entregar.
 *
 * Só é exibido quando o valor cobre a compra: abaixo do total o campo é um erro
 * de digitação, e a diferença deixaria de ser troco para virar dívida. O backend
 * valida de novo (upsertPaymentLines rejeita `received < amount`) — aqui é para
 * o cliente ver o número antes de confirmar, não para ser a única rede.
 */
function cashChangeLabel(receivedRaw, total) {
  const received = Number(String(receivedRaw ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(received) || received <= 0) return "";
  const change = Math.round((received - total) * 100) / 100;
  return change > 0 ? formatBRL(change) : "";
}

/**
 * Tem dados suficientes para pular direto para a confirmação? Telefone (para o
 * backend reconhecer o cliente e reaproveitar o rascunho), endereço completo (a
 * revisão mostra o endereço, e o pedido não fecha sem rua/número/bairro/cidade) e
 * forma de pagamento válida (o botão de confirmar não avança sem ela).
 */
function hasCompleteCheckoutData(profile, address) {
  if (!profile) return false;
  if (!digitsOnly(profile.phone ?? "")) return false;
  if (!["cash", "card", "pix"].includes(profile.payment)) return false;
  if (!address) return false;
  return Boolean(address.street && address.number && address.neighborhood && address.city);
}

// ---------------------------------------------------------------------------
function CheckoutScreen(props) {
  const { step, setStep, phone, onPhoneChange, onLookup, customer, selectedAddressId, setSelectedAddressId, newAddress, setNewAddress, payment, setPayment, items, subtotal, deliveryFee, paymentOptions, logoUrl, onBack, onSubmit, submitting, error, orderNotes, setOrderNotes, deliveryZoneKm, setDeliveryZoneKm, deliveryZones, onAddressChange, cashReceived, setCashReceived, addressForReview, reviewName, reviewPaymentLabel } = props;
  const titles = { phone: "Identificação", address: "Endereço de entrega", "new-address": "Endereço de entrega", payment: "Pagamento e nome", review: "Confirmar pedido" };

  // ---------- busca de CEP (ViaCEP) ----------
  // É conveniência, nunca bloqueio: o endereço continua digitável à mão e
  // falha nenhuma aqui pode virar o erro global do checkout (`error`) nem
  // desabilitar o "Continuar" — no máximo aparece uma dica ao lado do campo.
  const [cepNotice, setCepNotice] = useState(null); // { kind: "loading" | "error", text }
  // Toda edição de endereço passa por aqui: além de atualizar o estado, agenda
  // a gravação do perfil local (debounced). Sem isso o cache só conheceria o
  // endereço de quem chegou até o fim e fechou o pedido.
  //
  // A indireção por ref é porque `lookupCep` é um `useCallback` com deps
  // `[setNewAddress]` — puxar `onAddressChange` para as deps faria o timer do
  // debounce do CEP ser recriado a cada tecla digitada no endereço.
  const onAddressChangeRef = useRef(onAddressChange);
  onAddressChangeRef.current = onAddressChange;
  function onNewAddressChange(next) {
    setNewAddress(next);
    onAddressChangeRef.current?.(next);
  }

  const cepDigits = digitsOnly(newAddress.cep ?? "");
  // Último CEP buscado com sucesso: redigitar o mesmo número (ou voltar da aba
  // de outro campo) não pode gerar outra requisição.
  const cepDoneRef = useRef("");
  const cepTimerRef = useRef(null);
  const cepAbortRef = useRef(null);

  function onCepChange(value) {
    // A mensagem anterior sai na hora: ela descreve o CEP que estava na tela,
    // não o que o cliente acabou de digitar.
    setCepNotice(null);
    onNewAddressChange({ ...newAddress, cep: maskCep(value) });
  }

  // `useCallback` porque o efeito do debounce depende dela: sem isso o timer
  // seria recriado a cada render do formulário.
  const lookupCep = useCallback(async (digits) => {
    // Corrigir o CEP no meio da busca cancela a resposta velha — ela pertence a
    // um número que não está mais no campo.
    cepAbortRef.current?.abort();
    const controller = new AbortController();
    cepAbortRef.current = controller;
    setCepNotice({ kind: "loading", text: "Buscando CEP…" });
    try {
      const found = await fetchAddressByCep(digits, { signal: controller.signal });
      // Preenche só o que está vazio: o que o cliente digitou é dele. Rua,
      // bairro, cidade e UF vêm do CEP; número, complemento, referência e nome
      // continuam manuais — e CEP de município sem logradouro ainda traz bairro
      // e cidade. O `complement` do ViaCEP é descartado na origem (shared/api/cep.js):
      // ele vem como faixa ("de 101 a 150") e overwrite o que a pessoa escreveu.
      setNewAddress((prev) => {
        const next = {
          ...prev,
          street: prev.street || found.street,
          neighborhood: prev.neighborhood || found.neighborhood,
          city: prev.city || found.city,
          state: prev.state || found.state,
        };
        onAddressChangeRef.current?.(next);
        return next;
      });
      cepDoneRef.current = digits;
      setCepNotice(null);
    } catch (e) {
      if (controller.signal.aborted) return; // busca cancelada: a que vale é a nova
      setCepNotice({
        kind: "error",
        text: e.code === "not_found" ? "CEP não encontrado. Confira o número." : "Não foi possível buscar o CEP. Tente novamente.",
      });
    }
  }, [setNewAddress]);

  // Dispara com o CEP completo. O `onBlur` é rede de segurança: colar um CEP já
  // mascarado não passa pelas teclas.
  useEffect(() => {
    if (cepDigits.length !== 8 || cepDigits === cepDoneRef.current) return;
    // Debounce: sem ele cada tecla digitada vira uma requisição ao ViaCEP.
    const timer = setTimeout(() => lookupCep(cepDigits), 300);
    cepTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [cepDigits, lookupCep]);

  function flushCepSearch() {
    if (cepTimerRef.current) clearTimeout(cepTimerRef.current);
    if (cepDigits.length !== 8 || cepDigits === cepDoneRef.current) return;
    lookupCep(cepDigits);
  }

  useEffect(() => () => cepAbortRef.current?.abort(), []);

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
      <div className="flex-1 overflow-y-auto px-5 py-5 max-w-xl mx-auto w-full">
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
              onChange={(e) => onPhoneChange(e.target.value)}
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
            <ZoneSelector zones={deliveryZones} value={deliveryZoneKm} onChange={setDeliveryZoneKm} />
          </div>
        )}

        {step === "new-address" && (
          <div className="space-y-3">
            <Field label="Rótulo (opcional)" value={newAddress.label} onChange={(v) => onNewAddressChange({ ...newAddress, label: v })} placeholder="Casa, Trabalho..." />
            <div>
              <Field
                label="CEP"
                value={newAddress.cep}
                onChange={onCepChange}
                onBlur={flushCepSearch}
                placeholder="00000-000"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={9}
              />
              {cepNotice && (
                <p className={`mt-1 text-[12px] ${cepNotice.kind === "loading" ? "text-stone-500" : "text-red-400"}`}>
                  {cepNotice.text}
                </p>
              )}
            </div>
            <div className="flex gap-3">
              <Field label="Rua" value={newAddress.street} onChange={(v) => onNewAddressChange({ ...newAddress, street: v })} className="flex-[2]" />
              <Field label="Número" value={newAddress.number} onChange={(v) => onNewAddressChange({ ...newAddress, number: v })} className="flex-1" />
            </div>
            <Field label="Complemento (opcional)" value={newAddress.complement} onChange={(v) => onNewAddressChange({ ...newAddress, complement: v })} />
            <Field label="Bairro" value={newAddress.neighborhood} onChange={(v) => onNewAddressChange({ ...newAddress, neighborhood: v })} />
            <div className="flex gap-3">
              <Field label="Cidade" value={newAddress.city} onChange={(v) => onNewAddressChange({ ...newAddress, city: v })} className="flex-[3]" />
              <Field
                label="Estado"
                value={newAddress.state}
                onChange={(v) => onNewAddressChange({ ...newAddress, state: maskState(v) })}
                placeholder="UF"
                maxLength={2}
                autoComplete="address-level1"
                className="flex-[1]"
              />
            </div>
            <Field label="Ponto de referência (opcional)" value={newAddress.reference} onChange={(v) => onNewAddressChange({ ...newAddress, reference: v })} />
            {!customer && (
              <Field label="Seu nome" value={newAddress.customerName ?? ""} onChange={(v) => onNewAddressChange({ ...newAddress, customerName: v })} />
            )}
            <ZoneSelector zones={deliveryZones} value={deliveryZoneKm} onChange={setDeliveryZoneKm} />
          </div>
        )}

        {step === "payment" && (
          <div className="space-y-3">
            {paymentOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setPayment(opt.value);
                  if (opt.value !== "cash") setCashReceived("");
                }}
                className={`w-full text-left rounded-lg border p-3.5 flex items-center justify-between ${payment === opt.value ? "border-amber-500 bg-amber-500/10" : "border-stone-800 bg-stone-900"}`}
              >
                <span className="text-[14px] font-medium text-stone-50">{opt.label}</span>
                {payment === opt.value && <Check size={17} className="text-amber-400" />}
              </button>
            ))}

            {payment === "cash" && (
              <div className="rounded-lg border border-stone-800 bg-stone-900 p-3.5">
                <Field
                  label="Vai entregar quanto? (R$)"
                  value={cashReceived}
                  onChange={setCashReceived}
                  placeholder="Ex.: 50,00"
                  inputMode="decimal"
                />
                <p className="text-[12px] text-stone-500 mt-1.5">
                  Opcional. Deixe vazio se vai pagar o valor exato — aí o entregador não precisa levar troco.
                </p>
                {cashChangeLabel(cashReceived, subtotal + deliveryFee) && (
                  <p className="text-[13px] text-amber-400 font-semibold mt-2">
                    Troco: {cashChangeLabel(cashReceived, subtotal + deliveryFee)}
                  </p>
                )}
              </div>
            )}

            <Field
              label="Seu nome"
              value={newAddress.customerName ?? customer?.name ?? ""}
              onChange={(v) => onNewAddressChange({ ...newAddress, customerName: v })}
              placeholder="Como podemos te chamar?"
            />
            <p className="text-[12px] text-stone-600 -mt-1">
              É o nome que fica na comanda e o que o entregador chama você.
            </p>
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="rounded-lg bg-stone-900 border border-stone-800 p-4 mb-4">
              {items.map((it) => (
                <div key={it.key} className="flex justify-between text-[13.5px] py-1 text-stone-300 gap-3">
                  <span className="min-w-0">
                    {it.quantity}x {it.name}
                    {variationsText(it.selectedVariations) && (
                      <span className="block text-[12px] text-stone-500">{variationsText(it.selectedVariations)}</span>
                    )}
                  </span>
                  <span className="text-stone-500 shrink-0">{formatBRL(it.price * it.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-stone-800 mt-2 pt-2 flex justify-between text-[14px] font-bold text-stone-50">
                <span>Subtotal</span><span>{formatBRL(subtotal)}</span>
              </div>
              <div className="flex justify-between text-[13.5px] py-1">
                <span className="text-stone-300">Taxa de entrega</span><span className="text-stone-500">{formatBRL(deliveryFee)}</span>
              </div>
              <div className="flex justify-between text-[15px] font-extrabold pt-1">
                <span className="text-stone-50">Total</span><span className="text-amber-400">{formatBRL(subtotal + deliveryFee)}</span>
              </div>
            </div>
            {/* Resumo editável. É a tela que o cliente recorrente cai direto
                (startCheckout pula as três etapas quando o perfil tem tudo), então
                precisa mostrar e permitir corrigir cada dado sem voltar: tocar
                em qualquer linha leva à etapa correspondente. */}
            <div className="rounded-lg bg-stone-900 border border-stone-800 p-4 mb-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-stone-500 mb-2">
                Confira e toque para alterar
              </p>
              <div className="space-y-0.5">
                <EditRow
                  icon={<User size={15} />}
                  label="Nome"
                  value={reviewName}
                  onClick={() => setStep("payment")}
                />
                <EditRow
                  icon={<MapPin size={15} />}
                  label="Endereço"
                  value={formatAddress(addressForReview())}
                  onClick={() => setStep("new-address")}
                />
                <EditRow
                  icon={<CreditCard size={15} />}
                  label="Pagamento"
                  value={reviewPaymentLabel}
                  onClick={() => setStep("payment")}
                />
              </div>
              <p className="text-[13.5px] text-stone-500 mt-2 pt-2 border-t border-stone-800">
                Previsão de entrega: {zoneLabel(deliveryZoneKm, deliveryZones)}
              </p>
              {payment === "cash" && cashChangeLabel(cashReceived, subtotal + deliveryFee) && (
                <p className="text-[13.5px] text-amber-400 font-semibold mt-1">
                  Troco: {cashChangeLabel(cashReceived, subtotal + deliveryFee)}
                </p>
              )}
            </div>
            <div>
              <label className="block text-[12.5px] font-semibold text-stone-300 mb-1.5">
                Observação <span className="text-stone-500 font-normal">(opcional)</span>
              </label>
              <textarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                rows={3}
                maxLength={300}
                placeholder="Ex.: interfonar no 3º andar, portão azul…"
                className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-[13.5px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-600"
              />
              <p className="text-[11.5px] text-stone-600 mt-1">
                Vai junto do pedido inteiro: a cozinha e o entregador recebem esta observação. Para mudar um item
                específico, use a observação do próprio item no carrinho.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 pb-6 pt-3 border-t border-stone-800 max-w-xl mx-auto w-full">
        <button
          disabled={
            submitting ||
            (step === "phone" && !digitsOnly(phone)) ||
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
          {submitting ? "Enviando…" : step === "review" ? `Confirmar pedido · ${formatBRL(subtotal + deliveryFee)}` : "Continuar"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Timeline de fallback — usada só antes do primeiro GET de status (que
// acontece logo ao montar). O stage canônico vem do backend.
const FALLBACK_STEPS = [
  { stage: "received", label: "Pedido recebido" },
  { stage: "preparing", label: "Preparando" },
  { stage: "out_for_delivery", label: "Saiu para entrega" },
  { stage: "delivered", label: "Entregue" },
];

function ConfirmationScreen({ order, status, phone, onCancel, onReset, submitting, cancelError }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPhone, setCancelPhone] = useState(phone);

  const stage = status?.customerStage?.stage;
  const failed = stage === "failed";
  const cancelled = stage === "cancelled";
  const total = status?.total ?? order?.total;
  // A previsão em texto muda conforme o stage: antes de sair para entrega é uma
  // janela (preparo + viagem, ±20% — o backend devolve os dois lados prontos);
  // depois do despacho vira "chega até HH:MM", contada a partir do horário real
  // em que o motoboy pegou o pedido. Ver `etaForStage` no backend.
  const eta = etaLine(status?.estimatedWindow ?? order?.estimatedWindow, status?.deliverBy);
  const timeline = status?.timeline?.length
    ? status.timeline
    : FALLBACK_STEPS.map((s, i) => ({ ...s, done: i === 0, current: i === 0 }));
  const cancellable = CANCELLABLE_STAGES.includes(stage);

  const title = failed ? "Problema na entrega" : cancelled ? "Pedido cancelado" : "Pedido confirmado!";
  const hint = cancelled
    ? "Este pedido foi cancelado. Se não foi você, fale com o estabelecimento."
    : failed
      ? "Tivemos um problema pra entregar seu pedido. Entraremos em contato."
      : "Você pode acompanhar o andamento aqui — esta tela atualiza sozinha.";

  return (
    <div className="flex-1 flex flex-col px-6 pt-10 pb-8 overflow-y-auto max-w-xl mx-auto w-full">
      <div className="text-center mb-8">
        <div className={`w-14 h-14 rounded-full border flex items-center justify-center mx-auto mb-4 ${failed || cancelled ? "bg-red-500/15 border-red-500/40" : "bg-amber-500/15 border-amber-500/40"}`}>
          {cancelled ? <X size={24} className="text-red-400" /> : failed ? <AlertTriangle size={24} className="text-red-400" /> : <Check size={26} className="text-amber-400" />}
        </div>
        <h1 className="text-xl font-extrabold text-stone-50">{title}</h1>
        {!failed && !cancelled && (
          <p className="text-[13.5px] text-stone-500 mt-1">{eta} · Total {formatBRL(total)}</p>
        )}
      </div>

      {(failed || cancelled) && (
        <div className="flex items-start gap-2 text-red-400 text-[13px] bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-6">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {hint}
        </div>
      )}

      <div className="space-y-0">
        {timeline.map((s, i) => {
          const isLast = i === timeline.length - 1;
          const next = timeline[i + 1];
          return (
            <div key={s.stage} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors duration-500 ${s.done || s.current ? "bg-amber-500 text-[var(--brand-accent-foreground)]" : "bg-stone-900 text-stone-500 border border-stone-800"}`}>
                  {s.done ? <Check size={16} /> : s.current ? <PartyPopper size={15} /> : <span className="w-2 h-2 rounded-full bg-current" />}
                </div>
                {!isLast && <div className={`w-0.5 flex-1 min-h-[28px] transition-colors duration-500 ${next?.done || next?.current ? "bg-amber-500" : "bg-stone-800"}`} />}
              </div>
              <div className="pb-7 pt-1.5">
                <p className={`text-[14px] font-medium transition-colors duration-500 ${s.done || s.current ? "text-stone-50" : "text-stone-500"}`}>{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {cancellable && !cancelOpen && (
        <button
          onClick={() => {
            setCancelPhone(phone);
            setCancelOpen(true);
          }}
          className="w-full mt-2 border border-stone-800 rounded-xl h-12 font-semibold text-[14px] text-stone-400 hover:text-stone-200 hover:border-stone-700"
        >
          Cancelar pedido
        </button>
      )}

      {cancelOpen && (
        <Modal
          title="Cancelar pedido?"
          onClose={() => setCancelOpen(false)}
          footer={
            <div className="flex gap-3">
              <button
                onClick={() => setCancelOpen(false)}
                className="flex-1 h-11 rounded-xl border border-stone-800 text-[14px] font-semibold text-stone-300"
              >
                Voltar
              </button>
              <button
                onClick={() => onCancel(digitsOnly(cancelPhone))}
                disabled={submitting || !digitsOnly(cancelPhone)}
                className="flex-1 h-11 rounded-xl bg-red-500/90 text-white font-semibold text-[14px] disabled:opacity-40"
              >
                {submitting ? "Cancelando…" : "Confirmar cancelamento"}
              </button>
            </div>
          }
        >
          <div className="p-5">
            <p className="text-[13px] text-stone-500">
              {failed
                ? "A entrega falhou e este pedido ainda está aberto — cancelar evita cobrança."
                : "Enquanto o pedido não sair para entrega, o cancelamento é imediato."}
            </p>
            <label className="block mt-4">
              <span className="text-[12px] text-stone-500 mb-1 block">Telefone do pedido</span>
              <input
                value={cancelPhone ? maskPhone(cancelPhone) : ""}
                onChange={(e) => setCancelPhone(maskPhone(e.target.value))}
                inputMode="tel"
                placeholder="(11) 99999-0000"
                className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3.5 h-11 text-[14px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-600"
              />
            </label>
            {cancelError && (
              <div className="flex items-start gap-2 text-red-400 text-[12.5px] bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mt-3">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {cancelError}
              </div>
            )}
          </div>
        </Modal>
      )}

      {!failed && !cancelled && (
        <p className="text-center text-[11.5px] text-stone-500 mt-2">Esta tela atualiza sozinha — não precisa dar refresh.</p>
      )}

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
        <img src={assetUrl(logoUrl)} alt="Logo do restaurante" className="h-9 w-9 rounded-full object-contain shrink-0 ml-auto" />
      )}
    </div>
  );
}
// Campos de input extras (`inputMode`, `autoComplete`, `maxLength`, `onBlur`)
// são opcionais: os usos antigos do `Field` seguem igual, e o CEP é quem precisa
// de teclado numérico e da colagem de CEP já mascarado do navegador.
function Field({ label, value, onChange, placeholder, className = "", inputMode, autoComplete, maxLength, onBlur }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[12px] text-stone-500 mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        className="w-full bg-stone-900 border border-stone-800 rounded-lg px-3.5 h-11 text-[14px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-500"
      />
    </label>
  );
}
