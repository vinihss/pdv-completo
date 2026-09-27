import { config } from "../../config/env.js";

/**
 * Configuração de nível APP para a Cloud API (espelha integrations/ifood/config.ts).
 *
 * A distinção que importa aqui: env guarda o que é do APP da Meta — o mesmo
 * para toda loja que se conectar nele. O token do CLIENTE é por WABA e vive
 * no banco (whatsapp_connection, migration 0002), porque o Embedded Signup
 * entrega um token por conta conectada, não por instalação.
 */
export const whatsappConfig = {
  appId: config.metaAppId,
  appSecret: config.metaAppSecret,
  // Configuração v4 do Embedded Signup (Builder). O browser precisa dela
  // para chamar FB.login, por isso GET /whatsapp/config expõe.
  signupConfigId: config.whatsappSignupConfigId,
  graphVersion: config.whatsappGraphVersion,
  graphBaseUrl: config.whatsappGraphBaseUrl,
  verifyToken: config.whatsappVerifyToken,

  // Monta uma URL da Graph. `path` já vem com a barra inicial.
  url: (path: string): string => `${whatsappConfig.graphBaseUrl}/${whatsappConfig.graphVersion}${path}`,
};

/**
 * Dá para ABRIR o Embedded Signup? Exige app id + secret (a troca do code é
 * server-side) e a config v4 (é o que declara produtos, assets e permissões).
 */
export function canStartEmbeddedSignup(): boolean {
  return Boolean(whatsappConfig.appId && whatsappConfig.appSecret && whatsappConfig.signupConfigId);
}

/**
 * Assinatura de webhook e appsecret_proof exigem o app secret. Sem ele a
 * rota do webhook não valida assinatura nenhuma (e avisa), porque responder
 * 200 sem verificação abriria o PDV para forjar mensagem do cliente.
 */
export function hasAppSecret(): boolean {
  return Boolean(whatsappConfig.appSecret);
}
