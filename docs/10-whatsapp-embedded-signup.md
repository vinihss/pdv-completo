# WhatsApp Cloud API — Embedded Signup

Como o PDV conecta o WhatsApp Business de cada loja, envia mensagens e
acompanha a entrega delas. O documento é operacional: o que precisa existir
no painel da Meta, o que o backend faz sozinho, o que o gerente clica e o
que costuma dar errado.

Complementa `06-ifood-integration.md` (mesma forma: painel do gerente + módulo
do backend), mas este usa a **Cloud API da Meta** com token **por WABA**.

---

## 1. O problema que isso resolve

O token de acesso do WhatsApp é **por conta do WhatsApp Business (WABA)**,
não por instalação do PDV. Uma loja que já tem número no WhatsApp não pode
simplesmente colar o token num `.env` de um servidor que é de outra loja.

O **Embedded Signup** é o fluxo oficial da Meta para resolver isso: o
gerente loga na conta da empresa dentro de um popup da Meta, autoriza o
PDV, e a Meta devolve um **code** de uso único. O backend troca esse code
pelo token daquela WABA e guarda no banco.

O que fica no ambiente (`META_APP_ID`, `META_APP_SECRET`,
`WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`) é o que pertence ao **app da Meta** — o
mesmo para toda loja que se conectar nele. O que é **do cliente** (o token)
vai para `whatsapp_connection`.

## 2. Decisões

| Decisão | Por quê |
|---|---|
| Uma WABA ativa por instalação | Índice único parcial `uq_whatsapp_single_active`. A UI de conexão é simples e não há ambiguidade de roteamento. Reconectar a mesma WABA atualiza a linha. |
| Somente Cloud API com **número novo** | Coexistence (número pessoal em Business) exige outro produto e outro app review. Fora do escopo. |
| Token em **texto puro** | É o que a Meta emite e o que a API exige. O risco é exposição de banco/backup — o banco já guarda PIN de usuário em hash, mas token tem que ser reversível. Mitigação: o token nunca sai do backend por rota (ver §6). |
| Webhook inclui `messages.statuses` | Sem isso, "entregue"/"falhou" nunca chega ao PDV e o gerente não descobre por que o cliente não recebeu. |
| Poluição zero: o bot não responde a tipo desconhecido | `image`, `interactive`, `button` etc. são ignorados. Responder errado é pior que não responder. |

## 3. Pré-requisitos (dependência externa, não dá para automatizar)

1. **App na Meta for Developers**, do tipo *Business*.
2. **Produtos** adicionados ao app: *WhatsApp*.
3. **Permissões** solicitadas e aprovadas (*App Review* / *Advanced Access*):
   - `whatsapp_business_management`
   - `whatsapp_business_messaging`
   - `business_management`
4. **Configuração do Embedded Signup (v4)**: no painel do app, em
   *WhatsApp → Embedded Signup*, criar a configuração e copiar o
   `configuration_id`.
5. **Uma conta do WhatsApp Business** com um número **novo**, sem verify
   pendente e com o app dono da conta adicionado como administrador
   (ou um **Portfólio** de negócio, se a empresa já usa).

> Sem o App Review, o botão "Conectar" aparece para o gerente mas a troca do
> code falha — é a dependência externa mais comum de travar a integração.

## 4. Configuração do servidor

```bash
# backend/.env (ou o .env do deploy)
META_APP_ID=1234567890123456
META_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=1234567890123456
WHATSAPP_GRAPH_VERSION=v25.0
WHATSAPP_VERIFY_TOKEN=um-valor-aleatorio-que-voce-inventar
```

`META_APP_ID` e `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` **vão para o browser**
(via `GET /whatsapp/config`) porque o FB SDK precisa deles. `META_APP_SECRET`
**nunca** sai do backend.

No painel da Meta, a URL de callback é:

```
https://<seu-dominio>/webhooks/whatsapp
```

e o campo *Verify token* é o mesmo `WHATSAPP_VERIFY_TOKEN`.

> **Atenção ao path.** O webhook fica **fora** de `/api` de propósito, e os
> três Caddyfiles (`deploy/Caddyfile`, `Caddyfile.dev`, `Caddyfile.local`)
> têm uma rota `/webhooks/*` só para isso. Sem ela, o GET/POST do webhook cai
> no frontend estático e a Meta nunca consegue cadastrar o callback.

## 5. O que o gerente faz

1. Configurações → **Modo de operação** → ligar **Integração WhatsApp**
   (`store_settings.whatsapp_integration_enabled`, default `false`). O painel
   do WhatsApp passa a aparecer logo abaixo, na mesma tela de Configurações —
   deixou de ser item do menu esquerdo. Desligar o toggle esconde o painel sem
   desconectar a conta.
2. Se o servidor não estiver configurado, o painel lista as variáveis que
   faltam — não adianta clicar em "Conectar".
3. **Conectar WhatsApp** abre o popup da Meta. Logar na conta da empresa e
   autorizar. É um popup da Meta, não um formulário: não dá para contornar.
4. O PDV troca o code, registra o número e assina os webhooks. O painel passa
   a mostrar número, nome na Meta e empresa.
5. **Desconectar** apaga o token. while ele existir, qualquer chamada futura
   da Meta com ele continua válida — por isso desconectar é revogar de fato.

## 6. Fluxo das mensagens

**Envio** (`whatsapp.client.ts`): resolve a conexão ativa, monta a
`appsecret_proof`, chama `POST /{phone_number_id}/messages` e devolve o
**wamid**. O `wamid` é gravado em `whatsapp_outbound_message` junto com o
`order_id` — é o que permite saber, depois, para qual pedido a mensagem
entregue pertence.

**Recebimento** (`whatsapp-webhook.routes.ts`):

- `X-Hub-Signature-256` é conferido com o `appsecret_proof`. Sem
  `META_APP_SECRET`, a rota responde 503 em vez de aceitar payload sem
  verificar.
- O **lote inteiro** é processado (`entry × changes × messages`), não só a
  primeira mensagem — a Meta agrupa várias e a implementação anterior
  descartava o resto em silêncio.
- O roteamento é por `phone_number_id` do payload: a mensagem vai para a WABA
  dela. Sem `metadata`, cai na conexão ativa (única por instalação). Com um
  `phone_number_id` que **não** corresponde a nada, é ignorada — cair para a
  ativa responderia na WABA errada.
- **Dedupe por wamid**: a Meta reenvia o mesmo webhook até receber 200 (por
  até ~7 dias). O `INSERT` de `whatsapp_inbound_message` é a reserva.
- A resposta é **200 antes de processar** (fire-and-forget), porque a Meta
  reenvia qualquer coisa que não seja 200 rápido.

**Status** (`messages.statuses`): `sent → delivered → read`, ou `failed` com
o motivo. Aplicado por `wamid`, na mesma transação do log de auditoria, e
publicado no room `whatsapp` para a aba do gerente.

## 7. API

Todas manager-only (`requireRole("manager")`), em `/api`:

| Rota | O que faz |
|---|---|
| `GET /whatsapp/status` | Estado da conexão. **Nunca** inclui o access token. |
| `GET /whatsapp/config` | `appId`, `configId`, `graphVersion` — o que o browser precisa pro `FB.login`. Só valor público. |
| `POST /whatsapp/embedded-signup/exchange` | Troca o code, valida escopos, registra o número, assina os webhooks. |
| `POST /whatsapp/disconnect` | Apaga o token (revoga de fato). |
| `GET /whatsapp/messages` | Histórico das enviadas com o status da Meta. |

Webhook (fora de `/api`, sem auth, com assinatura):

| Rota | O que faz |
|---|---|
| `GET /webhooks/whatsapp` | Handshake de verificação (`hub.mode`/`hub.verify_token`/`hub.challenge`). |
| `POST /webhooks/whatsapp` | Lote de mensagens + status. |

Erros de domínio (`src/domain/errors.ts`):

| Código | HTTP | Quando |
|---|---|---|
| `whatsapp_not_configured` | 409 | Faltou `META_APP_ID`/`SECRET`/`CONFIG_ID` no servidor. |
| `whatsapp_invalid_code` | 400 | Code expirado (30s), já usado ou `redirect_uri` errado. |
| `whatsapp_missing_scopes` | 422 | O token não tem os escopos; `details.missing` diz quais. |
| `whatsapp_provider_error` | 502 | A Meta recusou (`details` traz o erro cru, útil para o gerente). |

## 8. Testes

`backend/test/whatsapp.test.ts` (35 testes) sobe um **stub da Graph API** em
porta fixa e aponta `WHATSAPP_GRAPH_BASE_URL` para ele pelo `env` do
`vitest.config.ts` — o `config` de `env.ts` é um snapshot feito no load do
módulo, então a URL precisa estar resolvida antes de qualquer import. O stub
recalcula o HMAC, não aceita valor mágico.

Cobre: fan-out do lote, dedupe, assinatura (inclusive com segredo errado),
handshake, ordem do onboarding (register antes de `subscribed_apps`),
`appsecret_proof`, escopo faltando, code inválido, provider error, token
expirado, WABA desconhecida, e o ciclo de status.

No frontend, `src/entities/whatsapp/lib/embeddedSignup.test.js` cobre a
extração do `postMessage` — em especial a checagem de `origin`, que sem ela
deixaria qualquer página aberta pelo gerente escolher a WABA que o PDV tenta
conectar.

Rodar: `cd backend && npm run test` e `cd frontend && npm run test`.

## 9. Diagnóstico

| Sintoma | Causa provável |
|---|---|
| Botão "Conectar" some / lista de variáveis faltando | `.env` sem `META_APP_ID`/`SECRET`/`CONFIG_ID`, ou container não recriado. |
| `whatsapp_invalid_code` na hora de trocar | O code tem **30s** e é de uso único. Refaça o fluxo do zero — não reenvie o request. |
| `whatsapp_missing_scopes` | O cliente autorizou sem as permissões do produto. Reautorizar com o app correto. |
| Envia mas a resposta do cliente nunca chega | Faltou `POST /{waba}/subscribed_apps`. O backend faz isso no onboarding; se foi feito à mão, confira. |
| `GET /webhooks/whatsapp` dá 404 pelo domínio | Rota `/webhooks/*` ausente no Caddy (ver §4). |
| Tudo 401 no POST do webhook | `META_APP_SECRET` diferente do do app da Meta, ou proxy reescrevendo o corpo (a assinatura é sobre o corpo **cruto**). |
| Aba mostra "Token expirado" | Token da WABA expirou. Reconecte. |
| Cliente não recebe, mas o PDV diz "Enviada" | Status não voltou. Confira se a WABA está inscrita no app e se o webhook aponta para a URL pública. |

## 10. Pendências

- Revogação formal do token na API da Meta (`DELETE /{waba}/...`) ao
  desconectar — hoje o apagamento é local, o que é válido para o PDV mas não
  mata o token do lado da Meta.
- Reconciliation: `GET /{waba}/phone_numbers` para detectar número removido
  ou desativado do lado do cliente.
- Métricas de qualidade de número (`quality_rating`) na UI — hoje só o log
  de auditoria guarda.
- Templates de mensagem com aprovação prévia da Meta (hoje é texto livre).
