/**
 * Embedded Signup da Meta (v4) no browser.
 *
 * O fluxo da Meta tem três passos, e vale entender quem é dono de cada um
 * porque é aí que a maioria das implementações quebra:
 *
 *  1. **FB.login** abre a janela da Meta. Não dá para "conectar" por fora:
 *     o gerente tem que logar na conta da empresa. É por isso que isto é
 *     uma dependência externa e não um formulário.
 *  2. **postMessage** — a janela manda um evento `WA_EMBEDDED_SIGNUP` com o
 *     code e os ids. O `FB.login` callback sozinho NÃO basta: com
 *     `response_type: "code"` ele devolve o code, mas o `phone_number_id` às
 *     vezes só vem no postMessage.
 *  3. **Troca no backend** — o code vira token de.access_token da WABA.
 *     Isso NUNCA acontece aqui: o app_secret não pode estar no browser, e o
 *     token resultante é da WABA do cliente, não do app.
 *
 * Por isso a parte testável daqui é só a extração do payload; o resto é
 * cola com a Meta e não tem como testar sem o popup real.
 */

export const FB_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
export const FACEBOOK_ORIGIN = "https://www.facebook.com";
export const SIGNUP_EVENT_TYPE = "WA_EMBEDDED_SIGNUP";

/**
 * Extrai o payload do Embedded Signup de um evento de `message`.
 *
 * Devolve `null` (e nunca lança) para qualquer coisa que não seja o evento
 * que a gente espera — a página ouve `message` de todo mundo, e o SDK da
 * Meta, o chat do Facebook e outros iframes postam por aí. Descartar é o
 * comportamento certo para o que não é nosso.
 *
 * A checagem de `origin` não é paranoia: sem ela, qualquer página que o
 * gerente tenha aberto mandaria um `postMessage` com um code falso e o
 * backend trocaria um code inventado — que falharia, mas só depois de o
 * atacante controlar qual WABA o gerente tenta conectar.
 */
export function extractSignupPayload(event) {
  if (!event || event.origin !== FACEBOOK_ORIGIN) return null;

  const data = event.data;
  if (!data || data.type !== SIGNUP_EVENT_TYPE) return null;

  // O shape documentado é data.payload; alguma versão do popup manda plano.
  const raw = data.payload ?? data;
  if (!raw || typeof raw !== "object") return null;

  const code = typeof raw.code === "string" ? raw.code : null;
  if (!code) return null; // sem code não há o que trocar

  // ids são opcionais de propósito: a Meta omite o phone_number_id em
  // alguns caminhos, e o backend descobre sozinho via /{waba}/phone_numbers.
  const str = (v) => (typeof v === "string" && v ? v : null);
  return {
    code,
    wabaId: str(raw.wabaId ?? raw.waba_id),
    phoneNumberId: str(raw.phoneNumberId ?? raw.phone_number_id),
    businessId: str(raw.businessId ?? raw.business_id),
    businessName: str(raw.businessName ?? raw.business_name),
  };
}

/**
 * Carrega o SDK da Meta uma vez só. Várias abas do gerente podem pedir o
 * Embedded Signup; o script não pode ser inserido duas vezes (a Meta
 * reinicializa o estado quando acontece).
 */
let sdkPromise = null;

export function loadFacebookSdk() {
  if (typeof window === "undefined") return Promise.reject(new Error("sem window"));
  if (window.FB) return Promise.resolve(window.FB);

  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const existing = document.getElementById("fb-sdk");
      const script = existing ?? document.createElement("script");
      const onLoad = () => (window.FB ? resolve(window.FB) : reject(new Error("FB indisponível")));
      script.addEventListener("load", onLoad);
      script.addEventListener("error", () => reject(new Error("Falha ao carregar o SDK da Meta")));
      if (!existing) {
        script.id = "fb-sdk";
        script.src = FB_SDK_URL;
        script.async = true;
        script.defer = true;
        // A Meta exige o div raiz para montar o popup de login.
        const root = document.createElement("div");
        root.id = "fb-root";
        document.body.appendChild(root);
        document.head.appendChild(script);
      }
    }).catch((err) => {
      sdkPromise = null; // deixa o próximo clique tentar de novo
      throw err;
    });
  }
  return sdkPromise;
}

/**
 * Roda o Embedded Signup inteiro e devolve o payload do postMessage.
 *
 * `onPayload` é chamado assim que o evento chega, e a promise resolve com
 * ele — a UI usa os dois (o callback para fechar o modal imediatamente, a
 * promise para o fluxo `await`). `onCancel` cobre o caso do gerente fechar
 * a janela sem autorizar.
 */
export async function startEmbeddedSignup({ appId, configId, onPayload, onCancel }) {
  if (!appId || !configId) {
    throw new Error("O WhatsApp ainda não está configurado neste servidor.");
  }

  const FB = await loadFacebookSdk();
  FB.init({ appId, xfbml: true, version: "v25.0" });

  return new Promise((resolve, reject) => {
    let settled = false;

    const onMessage = (event) => {
      const payload = extractSignupPayload(event);
      if (!payload) return; // não é o nosso evento: segue ouvindo
      settled = true;
      cleanup();
      onPayload?.(payload);
      resolve(payload);
    };

    // O popup não manda nada se o gerente fechar sem autorizar; o callback do
    // login é o único sinal de cancelamento confiável.
    const onLogin = (response) => {
      if (settled) return;
      if (response?.status !== "connected" && !response?.authResponse) {
        settled = true;
        cleanup();
        onCancel?.();
        reject(new Error("Você cancelou o cadastro no WhatsApp."));
      }
    };

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      settled = true;
    };

    window.addEventListener("message", onMessage);
    try {
      FB.login(onLogin, { config_id: configId, response_type: "code" });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
