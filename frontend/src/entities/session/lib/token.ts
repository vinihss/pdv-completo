// Leitura local do `exp` de um JWT, sem validar assinatura (isso é papel do
// backend). Serve só para decidir ANTES de uma chamada se a sessão ainda vale
// a pena usar: com menos de 5min de vida, o boot gira o refresh token
// preventivamente (docs/26 §5) em vez de deixar a primeira requisição da
// tela cair com 401.
export function decodeTokenExp(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    // base64url do JWT: `-`/`_` no lugar de `+`/`/`, sem padding.
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = JSON.parse(json)?.exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}
