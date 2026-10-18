const EXAMPLES = {
  new_order: [
    "quero fazer um pedido", "quero pedir", "queria pedir uma comida", "vou fazer outro pedido",
    "quero pedir de novo", "me manda o cardapio", "pode mandar o menu", "quero ver o cardapio",
    "abre o cardapio para mim", "quero comprar comida", "gostaria de fazer uma encomenda",
    "preciso encomendar para hoje", "quero fazer uma compra", "como faco um pedido",
    "quero pedir pelo delivery", "vou pedir uma entrega", "quero retirar um pedido novo",
    "tem como pedir agora", "manda as opcoes do menu", "quero escolher os produtos",
    "queria fazer um pedido para entrega", "vamos pedir", "aceita pedido hoje", "quero iniciar um pedido",
    "faz um pedido para mim", "queria pedir novamente", "preciso do cardapio", "me ve o menu",
    "quero comprar", "vou encomendar", "quero pedir pelo whatsapp", "me passa o cardapio por favor",
  ],
  track_order: [
    "onde esta meu pedido", "quero acompanhar meu pedido", "qual o status do pedido",
    "como esta a minha entrega", "meu pedido ja saiu", "quando meu pedido chega",
    "quero saber do pedido que fiz", "pode rastrear meu pedido", "cadê meu pedido",
    "me diz onde esta a entrega", "meu pedido esta pronto", "qual a situacao do pedido",
    "quero ver o andamento do pedido", "a entrega ja saiu para entrega", "meu pedido foi enviado",
    "fiz um pedido e quero acompanhar", "tem noticia do meu pedido", "quanto falta para chegar",
    "queria saber quando chega", "o entregador ja saiu", "meu pedido foi confirmado",
    "acompanha a entrega para mim", "consulta o pedido", "ver pedido em andamento",
    "pedido numero 123 onde esta", "quero saber se meu pedido saiu", "status da minha compra",
    "ja entregaram meu pedido", "meu pedido chegou", "preciso acompanhar a entrega",
    "como rastrear a encomenda", "me fala a fase do meu pedido",
  ],
  unrelated: [
    "oi", "ola", "bom dia", "boa tarde", "boa noite", "tudo bem", "obrigado", "muito obrigado",
    "valeu", "ate logo", "qual o horario de funcionamento", "onde fica a loja", "qual o endereco",
    " voces abrem domingo", "tem estacionamento", "quais formas de pagamento aceitam",
    "quero falar com uma pessoa", "preciso de ajuda", "tenho uma duvida", "manda um bom dia",
    "como chegar ai", "qual o telefone da loja", "parabens", "feliz natal", "ok entendido",
    "quanto custa a taxa de entrega", "tem vaga de emprego", "quero fazer uma reclamacao",
    "me liga por favor", "obrigada pela atencao", "boa noite tudo bem", "estou com saudade",
  ],
};

const STOP_WORDS = new Set([
  "a", "as", "o", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "e", "ou", "que", "para", "por", "com", "me", "te", "se", "eu", "voce", "voces", "meu", "minha", "seu", "sua",
  "ao", "aos", "pelo", "pela", "pra", "pro", "favor", "porfavor", "ai", "ja", "como", "qual", "quais", "tem", "um", "mais",
]);
const ALPHA = 0.8;
const MIN_CONFIDENCE = 0.54;
const MIN_MARGIN = 0.13;

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(/\s+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function train() {
  const model = {};
  const vocabulary = new Set();
  for (const [intent, examples] of Object.entries(EXAMPLES)) {
    const wordCounts = new Map();
    let tokenCount = 0;
    for (const example of examples) {
      for (const token of tokenize(example)) {
        vocabulary.add(token);
        wordCounts.set(token, (wordCounts.get(token) ?? 0) + 1);
        tokenCount += 1;
      }
    }
    model[intent] = { exampleCount: examples.length, wordCounts, tokenCount };
  }
  return { model, vocabulary };
}

const { model: MODEL, vocabulary: VOCABULARY } = train();
const INTENTS = Object.keys(MODEL);
const ORDER_TERMS = new Set([...MODEL.new_order.wordCounts.keys(), ...MODEL.track_order.wordCounts.keys()]);

function probabilities(tokens) {
  const totalExamples = INTENTS.reduce((sum, intent) => sum + MODEL[intent].exampleCount, 0);
  const scores = {};
  for (const intent of INTENTS) {
    const data = MODEL[intent];
    let score = Math.log(data.exampleCount / totalExamples);
    const denominator = data.tokenCount + ALPHA * (VOCABULARY.size + 1);
    for (const token of tokens) {
      score += Math.log(((data.wordCounts.get(token) ?? 0) + ALPHA) / denominator);
    }
    scores[intent] = score;
  }
  const max = Math.max(...Object.values(scores));
  const exp = Object.fromEntries(Object.entries(scores).map(([intent, score]) => [intent, Math.exp(score - max)]));
  const sum = Object.values(exp).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(exp).map(([intent, value]) => [intent, value / sum]));
}

/**
 * Classifica sem rede/chamada externa. `inScope` evita responder a conversas
 * sem sinal de pedido; `unclear` é devolvido quando há sinais de pedido mas a
 * classe não tem confiança/margem suficientes para uma ação automática.
 */
export function classifyIntent(text) {
  const normalized = normalizeText(text);
  if (normalized === "1") return { intent: "new_order", confidence: 1, inScope: true, probabilities: {} };
  if (normalized === "2") return { intent: "track_order", confidence: 1, inScope: true, probabilities: {} };
  const tokens = tokenize(text);
  if (!tokens.length) return { intent: "unrelated", confidence: 0, inScope: false, probabilities: {} };
  const probs = probabilities(tokens);
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const [topIntent, confidence] = ranked[0];
  const margin = confidence - ranked[1][1];
  const inScope = tokens.some((token) => ORDER_TERMS.has(token)) || probs.new_order + probs.track_order >= 0.58;
  if (!inScope) return { intent: "unrelated", confidence, inScope: false, probabilities: probs };
  if (tokens.length < 2) return { intent: "unclear", confidence, inScope: true, probabilities: probs };
  if (topIntent === "unrelated" && confidence >= 0.72) {
    return { intent: "unrelated", confidence, inScope: false, probabilities: probs };
  }
  if (topIntent === "unrelated" || confidence < MIN_CONFIDENCE || margin < MIN_MARGIN) {
    return { intent: "unclear", confidence, inScope: true, probabilities: probs };
  }
  return { intent: topIntent, confidence, inScope: true, probabilities: probs };
}
