import { describe, it, expect } from "vitest";
import { extractSignupPayload, FACEBOOK_ORIGIN, SIGNUP_EVENT_TYPE } from "./embeddedSignup.js";

/**
 * A extração do postMessage é a parte testável do Embedded Signup — e é a
 * parte sensível: a página ouve `message` de todo mundo, então qualquer
 * decisão errada aqui vira "o gerente conectou a conta errada".
 */

const payload = {
  code: "EAAabc",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  businessId: "biz-1",
};

const signupEvent = (data, origin = FACEBOOK_ORIGIN) => ({ origin, data });

describe("extractSignupPayload", () => {
  it("extrai o payload do evento do Embedded Signup", () => {
    const result = extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload }));
    expect(result).toEqual({
      code: "EAAabc",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      businessId: "biz-1",
      businessName: null,
    });
  });

  it("ignora origem que não é a Meta", () => {
    // Sem esta checagem, qualquer página aberta pelo gerente poderia mandar
    // um code falso e escolher a WABA que o PDV tenta conectar.
    expect(extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload }, "https://site-aleatorio.com"))).toBeNull();
    expect(extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload }, "http://www.facebook.com"))).toBeNull();
  });

  it("ignora eventos de message que não são do Embedded Signup", () => {
    expect(extractSignupPayload(signupEvent({ type: "OUTRO_COISA", payload }))).toBeNull();
    expect(extractSignupPayload(signupEvent({}))).toBeNull();
    expect(extractSignupPayload(signupEvent("string solta"))).toBeNull();
    expect(extractSignupPayload(signupEvent(null))).toBeNull();
    expect(extractSignupPayload(undefined)).toBeNull();
  });

  it("ignora evento do Embedded Signup sem code (não há o que trocar)", () => {
    expect(extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload: { wabaId: "w" } }))).toBeNull();
    expect(extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload: { code: "" } }))).toBeNull();
  });

  it("aceita o payload plano (alguma versão do popup manda assim)", () => {
    const result = extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, ...payload }));
    expect(result?.wabaId).toBe("waba-1");
  });

  it("normaliza o snake_case para o que o backend espera", () => {
    const result = extractSignupPayload(
      signupEvent({
        type: SIGNUP_EVENT_TYPE,
        payload: { code: "EAAabc", waba_id: "waba-2", phone_number_id: "phone-2", business_id: "biz-2" },
      })
    );
    expect(result).toMatchObject({ wabaId: "waba-2", phoneNumberId: "phone-2", businessId: "biz-2" });
  });

  it("deixa os ids como null quando a Meta não manda — o backend descobre", () => {
    // A Meta omite o phone_number_id em alguns caminhos; null aqui deixa o
    // /{waba}/phone_numbers do backend resolver, em vez de falhar a conexão.
    const result = extractSignupPayload(signupEvent({ type: SIGNUP_EVENT_TYPE, payload: { code: "EAAabc" } }));
    expect(result).toEqual({
      code: "EAAabc",
      wabaId: null,
      phoneNumberId: null,
      businessId: null,
      businessName: null,
    });
  });
});
