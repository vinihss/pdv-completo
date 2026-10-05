import crypto from "node:crypto";

// Assinatura do webhook do Pagar.me.
//
// O gateway manda o header `X-Hub-Signature`: HMAC-SHA1 do CORPO CRU, com a
// secret key da conta como chave, em hex. O exemplo canônico da própria doc é
//
//     cat postback_body | openssl dgst -sha1 -hmac "<sua api key>"
//
// dois pontos que costumam dar dor e estão tratados aqui:
//
//   - precisa ser o corpo CRU, não o objeto re-serializado. O parse/re-stringify
//     do Fastify muda espaçamento e ordem de chave e a HMAC não bate mais. Por
//     isso o servidor preserva `req.rawBody` (ver o content type parser em
//     http/server.ts, que já existe pelo webhook do WhatsApp).
//   - a comparação tem que ser de tempo constante, e `timingSafeEqual` LANÇA se
//     os buffers tiverem tamanhos diferentes — daí a checagem de comprimento
//     antes (o comprimento do hex é público, então comparar isso não vaza nada).
//
// ## Por que SHA-1 e não SHA-256
//
// É o esquema do Pagar.me; não é escolha nossa e não vamos inventar um
// esquema melhor que o do provedor, porque aí o webhook simplesmente nunca
// valida. SHA-1 está quebrado para colisão, o que não é a ameaça aqui (o
// atacante precisaria forjar uma assinatura válida sem conhecer a key, e o
// segredo é a defesa, não a resistência da função). A função fica isolada
// neste arquivo justamente para ser trocada sem tocar nas rotas.
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secretKey: string,
): boolean {
  if (!rawBody || !signatureHeader || !secretKey) return false;

  // Tolera o prefixo `sha1=` (convenção do X-Hub-Signature do GitHub, que o
  // Pagar.me também usa em parte da documentação) e hex em caixa alta ou baixa.
  const provided = signatureHeader.trim().replace(/^sha1=/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(provided)) return false;

  const expected = crypto.createHmac("sha1", secretKey).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}