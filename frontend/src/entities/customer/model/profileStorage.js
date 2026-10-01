// Perfil do cliente do checkout público: telefone, nome, endereço e forma de
// pagamento.
//
// Mesmo formato do rascunho do carrinho (entities/cart/model/cartStorage.js) —
// envelope versionado com `savedAt`, TTL, tudo em try/catch. A diferença que
// importa: o carrinho é descartado quando o pedido é confirmado, o perfil NÃO.
// Cliente que fecha o pedido e volta dez minutos depois para pedir outra coisa
// não deveria digitar o telefone e o endereço de novo — é a maior fricção do
// checkout público, e a única que não serve para nada.
//
// TTL de 30 dias (o carrinho usa 24h). Endereço de entrega é dado pessoal: some
// sozinho depois de um mês em vez de ficar no aparelho até o cliente limpar o
// navegador. Nada aqui é segurança — é conveniência num aparelho que o cliente
// controla. Quem tem medo de dado pessoal no navegador também não deve salvar
// carrinho, e o /pedido funciona sem isso.
//
// A forma de pagamento (`payment`) entra no mesmo envelope por uma razão
// prática: é o que permite pular direto para "Confirmar pedido" quando o
// cliente já pediu antes (ver `hasCompleteCheckoutData` na página).

const STORAGE_KEY = "pdv:customer-profile";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Campos de endereço espelham `customer_address`. `state` entrou na 0006. */
const ADDRESS_KEYS = ["label", "cep", "street", "number", "complement", "neighborhood", "city", "state", "reference"];

function emptyProfile() {
  return { phone: "", name: "", address: null, payment: null };
}

/**
 * Só o que o formulário precisa, na forma que o formulário espera. Um objeto
 * velho (sem `state`, com chave a mais, ou adulterado no console) vira null em
 * vez de quebrar o render — o cache é conveniência, nunca fonte de verdade.
 */
function sanitizeAddress(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const key of ADDRESS_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  // Endereço sem rua não serve: o checkout exige street para seguir, e uma meia
  // linha no formulário só faz o cliente perguntar de onde saiu.
  return out.street ? out : null;
}

/**
 * `payment` só é gravado quando é uma das opções conhecidas. É dado que volta
 * para a tela como botão marcado, então um valor desconhecido (perfil editado à
 * mão, versão antiga do app) ficaria como lixo que a tela não sabe desmarcar.
 */
function sanitizePayment(raw) {
  return typeof raw === "string" && ["cash", "card", "pix"].includes(raw) ? raw : null;
}

export function saveProfileLocal({ phone, name, address, payment }) {
  try {
    const profile = {
      phone: typeof phone === "string" ? phone : "",
      name: typeof name === "string" ? name : "",
      address: sanitizeAddress(address),
      payment: sanitizePayment(payment),
    };
    // Nada de útil ainda: não grava uma entrada vazia que só ocupa espaço.
    if (!profile.phone && !profile.name && !profile.address && !profile.payment) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...profile, savedAt: Date.now() }));
  } catch {
    /* aba anônima / storage bloqueado: o checkout funciona, só não persiste */
  }
}

export function loadProfileLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const data = JSON.parse(raw);
    if (data?.version !== 1) return emptyProfile();
    if (Date.now() - (data.savedAt ?? 0) > TTL_MS) {
      clearProfileLocal();
      return emptyProfile();
    }
    return {
      phone: typeof data.phone === "string" ? data.phone : "",
      name: typeof data.name === "string" ? data.name : "",
      address: sanitizeAddress(data.address),
      payment: sanitizePayment(data.payment),
    };
  } catch {
    return emptyProfile();
  }
}

/**
 * Apaga o perfil. O fluxo normal NÃO chama isto — finalizar um pedido preserva
 * telefone e endereço de propósito. O uso real é a expiração de 30 dias, que
 * se autolimpa na leitura, e o botão de privacidade, quando existir.
 */
export function clearProfileLocal() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
