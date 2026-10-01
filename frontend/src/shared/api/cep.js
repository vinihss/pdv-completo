// Consulta de endereço por CEP no ViaCEP (público, sem chave e sem CORS
// bloqueado). Vive em `shared/api` — e não no backend — porque é um serviço
// externo de uso genérico: `http.js` existe para o núcleo HTTP do PDV (prefixa
// `apiBase()` e carrega o token da sessão), e nada disso serve para um
// terceiro. Também não cabe em `shared/lib`, que é o que não fala com a rede.
//
// A resposta é normalizada aqui para o vocabulário do formulário de endereço
// (`street`/`neighborhood`/`city`/`state`), para a tela não conhecer os
// nomes do ViaCEP (`logradouro`, `localidade`, ...) e a normalização não ficar
// duplicada em cada consumidor.
//
// Falha vem como erro com `code`, no mesmo formato de `lookupPublicCustomer`:
//   invalid   — não são 8 dígitos (nem tenta sair para a rede)
//   not_found — ViaCEP respondeu `erro: true` (CEP inexistente)
//   network   — anything else (sem rede, 5xx, JSON inválido)
const VIACEP_BASE = "https://viacep.com.br/ws";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Endereço de um CEP. Campo vazio significa "o ViaCEP não sabe" — CEP de
 * município, por exemplo, volta sem `logradouro`. A tela que chama decide o
 * que fazer com o que faltar.
 */
export async function fetchAddressByCep(cep, { signal } = {}) {
  const digits = String(cep ?? "").replace(/\D/g, "");
  if (digits.length !== 8) throw fail("invalid", "CEP precisa de 8 dígitos");

  let res;
  try {
    res = await fetch(`${VIACEP_BASE}/${digits}/json/`, { signal });
  } catch {
    // O abort do `signal` cai aqui também e sai como `network`: quem chamou
    // sabe distinguir olhando `signal.aborted` (é assim que a tela ignora a
    // resposta de uma busca que ela mesma cancelou).
    throw fail("network", "Não foi possível consultar o CEP");
  }
  if (!res.ok) throw fail("network", `ViaCEP respondeu ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw fail("network", "Resposta do ViaCEP ilegível");
  }
  if (data?.erro) throw fail("not_found", "CEP não encontrado");

  // Só o que serve para identificar o endereço. O `complemento` do ViaCEP é
  // deliberadamente descartado: ele vem como faixa ("de 101 a 150", "lado
  // ímpar") e poluir o campo que a pessoa preenche à mão. Rua, bairro, cidade e
  // UF são dados reais; complemento é observação de quem mora lá.
  return {
    cep: data.cep ?? "",
    street: data.logradouro ?? "",
    neighborhood: data.bairro ?? "",
    city: data.localidade ?? "",
    state: data.uf ?? "",
  };
}