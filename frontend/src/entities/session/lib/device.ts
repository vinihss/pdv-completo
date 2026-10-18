// Preferência de empresa POR DISPOSITIVO (docs/26 §2, decisão 6): o slug da
// última loja escolhida mora no localStorage e serve só de atalho de UX —
// nunca é autoridade de segurança. O backend revalida o vínculo inteiro em
// `POST /auth/select-tenant` toda vez que o atalho é usado.
const TENANT_KEY = "pdv:tenant";

export function getDeviceTenantSlug() {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null; // storage indisponível (modo privado/bloqueado): fluxo sem atalho
  }
}

export function setDeviceTenantSlug(slug) {
  try {
    if (slug) localStorage.setItem(TENANT_KEY, slug);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    // Preferência é conforto, não dado crítico: gravar falhando não derruba o login.
  }
}
