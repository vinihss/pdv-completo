# Plano de correção do Multi-Tenant e Login por Subdomínio

## 1. Objetivo

Corrigir o fluxo atual de multi-tenant para que o tenant seja
determinado **exclusivamente pelo hostname da requisição**, mantendo a
UX atual:

``` text
https://umami.seudominio.com/login
        |
        v
resolveTenant(host)
        |
        v
tenant = umami
        |
        v
lista usuários do tenant
        |
        v
usuário seleciona
        |
        v
informa PIN
        |
        v
JWT { sub, tenant, role }
```

A proposta não troca a estratégia atual de banco. O projeto continua
usando:

-   `public.tenant` como registry;
-   um schema PostgreSQL por tenant;
-   `AsyncLocalStorage` para o contexto;
-   pool PostgreSQL dedicado ao schema;
-   `db` como proxy para o banco do tenant atual.

O foco é eliminar os caminhos concorrentes de resolução de tenant e
garantir que login, frontend, API e workers usem a mesma regra.

------------------------------------------------------------------------

# 2. Diagnóstico do código atual

## 2.1 O backend já possui a infraestrutura necessária

Arquivos relevantes:

``` text
backend/src/application/tenant/resolve-tenant.usecase.ts
backend/src/domain/tenant.ts
backend/src/infra/tenant/registry.ts
backend/src/infra/db/tenant-context.ts
backend/src/infra/db/tenant-db.ts
backend/src/infra/db/client.ts
```

O fluxo já existente é conceitualmente:

``` text
Host
  |
  v
resolveTenant()
  |
  v
TenantRecord
  |
  v
enterTenantScope()
  |
  v
AsyncLocalStorage
  |
  v
db Proxy
  |
  v
tenantDb(schema)
  |
  v
Pool com search_path
```

Essa parte deve ser preservada.

------------------------------------------------------------------------

# 3. Problema principal encontrado

## 3.1 Existem dois mecanismos de resolução

### Hook global

Em:

``` text
backend/src/http/server.ts
```

existe:

``` ts
app.addHook("onRequest", async (req) => {
  ...
  const tenant = await resolveTenant(...);
  enterTenantScope({
    schemaName: tenant.schemaName,
    isDefault: tenant.isDefault
  });
});
```

### Middleware adicional

Em:

``` text
backend/src/http/middlewares/tenant.middleware.ts
```

e atualmente utilizado em:

``` text
backend/src/http/routes/auth.routes.ts
```

a rota:

``` ts
app.get("/auth/users", { preHandler: tenantMiddleware }, ...)
```

resolve novamente o tenant.

### Problema

A aplicação passa a ter dois caminhos possíveis:

``` text
request
  |
  +--> onRequest -> resolveTenant
  |
  +--> preHandler -> tenantMiddleware
```

Isso aumenta a possibilidade de inconsistência e torna o comportamento
difícil de rastrear.

## Correção

O `onRequest` global deve ser a única porta de entrada do contexto de
tenant.

Depois da correção:

``` text
HTTP request
    |
    v
onRequest
    |
    v
resolveTenant()
    |
    v
enterTenantScope()
    |
    v
todos os handlers
```

O `tenantMiddleware` não deve mais ser necessário para as rotas normais.

------------------------------------------------------------------------

# 4. Correção imediata no `server.ts`

Arquivo:

``` text
backend/src/http/server.ts
```

## 4.1 Remover `query.host`

Hoje existe:

``` ts
const rawHost =
  (req.query as Record<string, unknown> | undefined)?.host ??
  req.headers["x-tenant-host"] ??
  req.hostname;
```

Isso permite que o cliente altere o tenant potencialmente através de:

``` text
?host=outro-tenant.seudominio.com
```

Não deve existir essa possibilidade.

## Substituir por

``` ts
const rawHost =
  req.headers["x-tenant-host"] ??
  req.hostname;
```

A regra deve ser:

``` text
Host/X-Tenant-Host
       |
       v
resolveTenant()
```

Nunca:

``` text
query parameter
       |
       v
tenant
```

------------------------------------------------------------------------

# 5. Cuidado com `X-Tenant-Host`

O projeto usa:

``` http
X-Tenant-Host
```

porque a API pode estar atrás de um domínio como:

``` text
api.seudominio.com.br
```

enquanto a loja é:

``` text
umami.seudominio.com.br
```

A arquitetura pode continuar assim, mas o header precisa ser controlado
pelo proxy.

O Caddy deve ser a origem confiável desse header.

A regra operacional deve ser:

``` text
Internet
   |
   v
Caddy
   |
   | X-Tenant-Host = hostname público
   v
Fastify
```

Não permitir que um cliente externo consiga escolher livremente:

``` http
X-Tenant-Host: outra-loja.seudominio.com
```

Se o mesmo domínio já identifica a loja, o ideal é fazer o Caddy
normalizar isso.

------------------------------------------------------------------------

# 6. `resolveTenant()` deve continuar sendo a autoridade

Arquivo:

``` text
backend/src/application/tenant/resolve-tenant.usecase.ts
```

A função já possui a lógica adequada:

``` ts
resolveTenant(host)
```

e resolve:

``` text
custom_domain
subdomínio/slug
apex/default
tenant inexistente
tenant suspenso
```

Não criar outra implementação no frontend ou nas rotas.

A regra deve ser:

``` text
resolveTenant()
```

é a única função responsável por transformar:

``` text
hostname -> tenant
```

------------------------------------------------------------------------

# 7. Fluxo recomendado para o login

O login atual possui duas telas:

``` text
seleção de usuário
       |
       v
PIN
```

Isso pode permanecer.

Não é necessário criar uma tela:

``` text
Selecione a empresa
```

porque o tenant já está definido pelo domínio.

## Fluxo final

``` text
umami.seudominio.com
        |
        v
Fastify
        |
        v
resolveTenant("umami.seudominio.com")
        |
        v
tenant_umami
        |
        v
GET /auth/users
        |
        v
db -> tenant_umami.users
        |
        v
usuário selecionado
        |
        v
POST /auth/login
        |
        v
db -> tenant_umami.users
        |
        v
validação do PIN
        |
        v
JWT
```

------------------------------------------------------------------------

# 8. `/auth/users`

Arquivo:

``` text
backend/src/http/routes/auth.routes.ts
```

Hoje:

``` ts
app.get("/auth/users", { preHandler: tenantMiddleware }, async (req) => {
```

## Alterar para

``` ts
app.get("/auth/users", async (_req) => {
```

O contexto já deverá existir graças ao:

``` text
server.ts -> onRequest
```

Não deve haver uma segunda resolução.

O restante da consulta pode permanecer:

``` ts
const settings = await db.query.storeSettings.findFirst(...);

const rows = await db.query.users.findMany(...);
```

Agora `db` já estará apontando para:

``` text
tenant_umami
```

------------------------------------------------------------------------

# 9. `/auth/login`

Também está em:

``` text
backend/src/http/routes/auth.routes.ts
```

Hoje:

``` ts
app.post("/auth/login", { preHandler: loginRateLimit }, async (req, reply) => {
  const body = loginSchema.parse(req.body);
  const result = await loginUsecase(body.userId, body.pin, body.deviceId);
  return reply.code(200).send(result);
});
```

Esse formato pode ser mantido.

A diferença importante é:

``` text
loginUsecase()
```

nunca deve receber um tenant informado pelo frontend.

Ele usa o tenant do contexto atual.

------------------------------------------------------------------------

# 10. Login use case

Arquivo:

``` text
backend/src/application/auth/login.usecase.ts
```

Hoje:

``` ts
const u = await db.query.users.findFirst({
  where: eq(users.id, userId)
});
```

Isso é correto **desde que o contexto já tenha sido estabelecido**.

Por exemplo:

``` text
umami.seudominio.com
       |
       v
tenant_umami
       |
       v
db.query.users
       |
       v
tenant_umami.users
```

Não adicionar:

``` ts
tenantId
tenantSlug
schemaName
```

ao payload vindo do frontend.

------------------------------------------------------------------------

# 11. JWT precisa carregar o tenant

Hoje o token é criado assim:

``` ts
const token = jwt.sign(
  {
    sub: u.id,
    role: u.role
  },
  config.jwtSecret,
  { expiresIn: "12h" }
);
```

Alterar para:

``` ts
const tenant = currentTenant();

const token = jwt.sign(
  {
    sub: u.id,
    role: u.role,
    tenant: tenant.slug
  },
  config.jwtSecret,
  { expiresIn: "12h" }
);
```

Para isso, o contexto deve fornecer o tenant completo.

------------------------------------------------------------------------

# 12. Melhorar o `TenantContext`

Arquivo atual:

``` text
backend/src/infra/db/tenant-context.ts
```

Hoje o contexto trabalha essencialmente com:

``` ts
{
  schemaName,
  isDefault
}
```

Recomendo passar a armazenar:

``` ts
export type TenantContext = {
  id: string;
  slug: string;
  schemaName: string;
  isDefault: boolean;
};
```

Se o registry ainda não possui `id`, não é necessário criar um UUID
somente para isso.

Nesse caso, inicialmente:

``` ts
export type TenantContext = {
  slug: string;
  schemaName: string;
  isDefault: boolean;
};
```

é suficiente.

O importante é que `slug` esteja disponível para o JWT.

------------------------------------------------------------------------

# 13. JWT deve validar o tenant

Arquivo:

``` text
backend/src/http/middlewares/auth.middleware.ts
```

Hoje:

``` ts
export interface AuthUser {
  sub: string;
  role: Role;
}
```

Alterar para:

``` ts
export interface AuthUser {
  sub: string;
  role: Role;
  tenant: string;
}
```

Depois do `jwt.verify()`:

``` ts
const payload = jwt.verify(token, config.jwtSecret) as AuthUser;

const tenant = currentTenant();

if (payload.tenant !== tenant.slug) {
  throw Errors.unauthorized();
}
```

Assim:

``` text
JWT criado em tenant A
        |
        v
acesso em tenant A
        |
        v
OK
```

mas:

``` text
JWT criado em tenant A
        |
        v
acesso em tenant B
        |
        v
401/403
```

Isso cria uma segunda barreira de isolamento.

------------------------------------------------------------------------

# 14. Frontend

Arquivos principais:

``` text
frontend/src/pages/login/LoginPage.jsx
frontend/src/entities/session/api/session.js
frontend/src/app/providers/auth/AuthProvider.jsx
```

## `session.js`

Hoje:

``` js
export function listLoginUsers() {
  return request("GET", "/auth/users");
}

export function login(userId, pin) {
  return request("POST", "/auth/login", { userId, pin });
}
```

Isso pode continuar praticamente igual.

Não adicionar:

``` js
tenant
schema
tenantId
```

ao request.

O browser já está em:

``` text
https://umami.seudominio.com
```

Portanto:

``` text
/api/auth/users
/api/auth/login
```

já pertencem ao contexto daquela origem.

------------------------------------------------------------------------

# 15. `LoginPage.jsx`

O fluxo atual:

``` text
select
  |
  v
pin
```

pode permanecer exatamente assim.

A alteração importante é conceitual:

``` text
LoginPage
    |
    +-- lista usuários
    |
    +-- seleciona usuário
    |
    +-- envia userId + pin
```

Ela não deve:

``` text
resolver tenant
guardar tenant em localStorage
alterar tenant baseado no usuário
montar URL de tenant
```

O domínio atual é a identidade do tenant.

------------------------------------------------------------------------

# 16. Problema adicional: configuração de servidor no frontend

Foi encontrado em:

``` text
frontend/src/shared/lib/server.js
```

e usado na tela de login:

``` js
getServerBase()
setServerBase()
serverDefault()
```

Existe também uma tela/configuração para alterar o servidor.

Isso é necessário para os aplicativos desktop/Tauri, mas cria uma
distinção importante:

### Navegador web

``` text
https://umami.seudominio.com
```

Deve usar:

``` text
origin atual
```

### Aplicativo desktop

``` text
tauri://localhost
```

Pode precisar de:

``` text
serverBase configurável
```

Não misturar os dois conceitos.

A aplicação web deve descobrir o tenant pelo hostname da página.

O desktop pode continuar usando `serverBase`, mas a API deve receber
explicitamente o hostname/tenant do estabelecimento configurado para
aquele aparelho.

------------------------------------------------------------------------

# 17. Regra importante para desktop

Para PDV/KDS/Garçom instalados:

``` text
Aplicativo
    |
    v
serverBase
    |
    v
API
```

Nesse cenário a API pode não ter:

``` text
umami.seudominio.com
```

como `Host`.

Portanto há duas opções.

## Opção recomendada

Configurar o aparelho com a URL completa do tenant:

``` text
https://umami.seudominio.com
```

e não:

``` text
https://api.seudominio.com
```

Assim o tenant continua sendo determinado pelo hostname.

## Evitar

Configurar:

``` text
API_BASE_URL=https://api.seudominio.com
TENANT=umami
```

e deixar o frontend mandar:

``` json
{
  "tenant": "umami"
}
```

Isso cria uma segunda autoridade de tenant.

------------------------------------------------------------------------

# 18. Caddy

Arquivos:

``` text
deploy/Caddyfile
deploy/Caddyfile.dev
deploy/Caddyfile.local
deploy/docker-compose.yml
```

A responsabilidade deve ficar:

``` text
hostname público
       |
       v
Caddy
       |
       v
Fastify
```

Para tenant:

``` text
umami.seudominio.com
```

o hostname precisa chegar ao backend de forma confiável.

Se estiver usando:

``` http
X-Tenant-Host
```

o Caddy deve sobrescrever o valor recebido do cliente.

Nunca simplesmente repassar um header arbitrário.

------------------------------------------------------------------------

# 19. `tenantMiddleware`

Arquivo:

``` text
backend/src/http/middlewares/tenant.middleware.ts
```

Recomendação:

### Curto prazo

Deixar o arquivo existente, mas parar de usá-lo nas rotas normais.

### Depois

Remover o arquivo quando todos os usos tiverem sido eliminados.

Verificar:

``` bash
grep -RIn "tenantMiddleware" backend/src
```

O resultado ideal deve ser nenhum uso em rotas.

------------------------------------------------------------------------

# 20. `TENANT_ROUTING`

Arquivo:

``` text
backend/src/application/tenant/resolve-tenant.usecase.ts
```

Atualmente existe um kill-switch:

``` env
TENANT_ROUTING=false
```

Quando desligado:

``` text
qualquer Host
    |
    v
default tenant
```

Isso é útil durante migração, mas é perigoso em produção.

Depois de registrar os tenants reais:

``` env
TENANT_ROUTING=true
```

E em produção:

``` env
TENANT_STRICT=true
```

A regra desejada é:

``` text
Host válido + tenant existente
    -> continua

Host válido + tenant inexistente
    -> 404

Tenant suspenso
    -> 403

Host ausente/inválido
    -> 404
```

Nunca:

``` text
tenant não encontrado
    -> default
```

------------------------------------------------------------------------

# 21. `DEFAULT_TENANT_SCHEMA`

O fallback pode continuar existindo para:

-   desenvolvimento;
-   testes;
-   migração;
-   manutenção controlada.

Mas não deve ser usado para mascarar erro de resolução em produção.

Ideal:

``` env
# desenvolvimento
TENANT_ROUTING=false
DEFAULT_TENANT_SCHEMA=public
```

Produção:

``` env
TENANT_ROUTING=true
TENANT_STRICT=true
```

------------------------------------------------------------------------

# 22. Teste obrigatório de isolamento

Criar testes que comprovem:

## Caso A

``` text
Host: umami.seudominio.com
GET /auth/users
```

Resultado:

``` text
somente usuários de tenant_umami
```

## Caso B

``` text
Host: loja2.seudominio.com
GET /auth/users
```

Resultado:

``` text
somente usuários de tenant_loja2
```

## Caso C

``` text
Host: umami.seudominio.com
POST /auth/login
userId pertencente a loja2
```

Resultado:

``` text
401
```

## Caso D

JWT de `umami` usado em:

``` text
loja2.seudominio.com
```

Resultado:

``` text
401/403
```

## Caso E

Tenant inexistente:

``` text
inexistente.seudominio.com
```

Resultado:

``` text
404 tenant_not_resolved
```

------------------------------------------------------------------------

# 23. Teste de concorrência

Esse teste é particularmente importante por causa do
`AsyncLocalStorage`.

Executar simultaneamente:

``` ts
await Promise.all([
  requestAsTenant("umami"),
  requestAsTenant("loja2"),
]);
```

Cada request deve consultar seu próprio schema.

Exemplo:

``` text
request A
    |
    +-- ALS = tenant_umami
    |
    +-- db = tenant_umami
    |
    +-- users = usuários A

request B
    |
    +-- ALS = tenant_loja2
    |
    +-- db = tenant_loja2
    |
    +-- users = usuários B
```

Nunca:

``` text
request A -> usuários B
```

------------------------------------------------------------------------

# 24. Workers: segundo ponto crítico

O contexto ALS funciona naturalmente em requests HTTP, mas não existe
automaticamente em workers.

Arquivos importantes:

``` text
backend/src/infra/realtime/outbox-dispatcher.ts
backend/src/infra/maintenance.ts
backend/src/integrations/ifood/worker.ts
backend/src/integrations/pagarme/worker.ts
```

Eles devem executar explicitamente dentro de um tenant.

Criar uma abstração:

``` ts
runInTenant(tenant, callback)
```

Exemplo:

``` ts
for (const tenant of await listActiveTenants()) {
  await runInTenant(tenant, async () => {
    await processJobs();
  });
}
```

Fluxo:

``` text
listActiveTenants()
        |
        +--> tenant A -> runInTenant()
        |
        +--> tenant B -> runInTenant()
        |
        +--> tenant C -> runInTenant()
```

Isso evita que worker caia silenciosamente no:

``` text
DEFAULT_TENANT_SCHEMA
```

------------------------------------------------------------------------

# 25. Ordem de implementação recomendada

## Fase 1 --- autenticação e request

### Alterar

``` text
backend/src/http/server.ts
backend/src/http/routes/auth.routes.ts
backend/src/application/auth/login.usecase.ts
backend/src/http/middlewares/auth.middleware.ts
backend/src/infra/db/tenant-context.ts
```

### Objetivo

Ter:

``` text
Host
 -> resolveTenant
 -> ALS
 -> db
 -> login
 -> JWT com tenant
```

------------------------------------------------------------------------

## Fase 2 --- frontend

### Revisar

``` text
frontend/src/pages/login/LoginPage.jsx
frontend/src/entities/session/api/session.js
frontend/src/app/providers/auth/AuthProvider.jsx
frontend/src/shared/lib/server.js
```

### Objetivo

Garantir:

``` text
frontend não escolhe tenant
frontend não envia tenant
frontend não salva tenant
frontend usa a origem atual
```

------------------------------------------------------------------------

## Fase 3 --- proxy

Revisar:

``` text
deploy/Caddyfile
deploy/Caddyfile.dev
deploy/Caddyfile.local
```

Garantir que:

``` text
X-Tenant-Host
```

não possa ser forjado pelo cliente.

------------------------------------------------------------------------

## Fase 4 --- testes

Adicionar testes para:

``` text
tenant A
tenant B
login
JWT
concorrência
tenant inexistente
tenant suspenso
```

------------------------------------------------------------------------

## Fase 5 --- workers

Depois do login funcionando:

``` text
outbox
maintenance
iFood
Pagar.me
```

devem usar:

``` ts
runInTenant()
```

------------------------------------------------------------------------

# 26. Fluxo final desejado

``` text
                         INTERNET
                            |
                            v
                umami.seudominio.com
                            |
                            v
                          CADDY
                            |
                            v
                         FASTIFY
                            |
                      onRequest()
                            |
                            v
                    resolveTenant()
                            |
                            v
                 ┌──────────────────┐
                 │ TenantContext    │
                 │ slug: umami      │
                 │ schema: tenant_* │
                 └────────┬─────────┘
                          |
                         ALS
                          |
             ┌────────────┴────────────┐
             |                         |
        /auth/users              /auth/login
             |                         |
             v                         v
            db                        db
             |                         |
             v                         v
       tenant_umami              tenant_umami
             |                         |
             v                         v
          usuários                  usuário
                                       |
                                      PIN
                                       |
                                       v
                                    JWT
                                       |
                         {sub, role, tenant}
```

Depois:

``` text
GET /products
Authorization: Bearer JWT
Host: umami.seudominio.com
```

continua automaticamente em:

``` text
tenant_umami.products
```

------------------------------------------------------------------------

# 27. Resultado esperado

Depois dessas alterações, a regra arquitetural fica simples:

### Tenant

``` text
HOST -> resolveTenant()
```

### Contexto

``` text
resolveTenant() -> ALS
```

### Banco

``` text
ALS -> db -> tenantDb(schema)
```

### Login

``` text
Host -> tenant -> users -> PIN -> JWT
```

### Autorização

``` text
JWT.tenant === currentTenant.slug
```

### Frontend

``` text
não decide tenant
```

### Worker

``` text
runInTenant()
```

### Banco

``` text
1 PostgreSQL
N schemas
N tenants
```

------------------------------------------------------------------------

# 28. Não fazer

Evitar estas soluções:

``` text
❌ tenant enviado pelo frontend
❌ tenant em localStorage como fonte de verdade
❌ tenant escolhido pelo usuário
❌ schema enviado pelo frontend
❌ query ?host=...
❌ fallback automático para public quando tenant não existe
❌ cada rota resolvendo tenant individualmente
❌ cada worker usando DEFAULT_TENANT_SCHEMA
❌ colocar tenant_id em todas as tabelas agora
❌ migrar para RLS agora
```

A infraestrutura atual de schema-per-tenant é suficiente.

------------------------------------------------------------------------

# 29. Checklist de implementação

``` text
[ ] Remover req.query.host
[ ] Fazer onRequest ser a única resolução HTTP
[ ] Remover tenantMiddleware das rotas normais
[ ] Garantir contexto antes de /auth/users
[ ] Garantir contexto antes de /auth/login
[ ] Adicionar tenant ao TenantContext
[ ] Adicionar tenant ao JWT
[ ] Validar JWT.tenant contra currentTenant()
[ ] Não enviar tenant pelo frontend
[ ] Revisar serverBase para desktop
[ ] Revisar X-Tenant-Host no Caddy
[ ] Ativar TENANT_ROUTING em produção
[ ] Testar tenant A
[ ] Testar tenant B
[ ] Testar JWT cruzado
[ ] Testar concorrência
[ ] Criar runInTenant()
[ ] Migrar workers para runInTenant()
```

# 30. Arquivos prioritários

  ----------------------------------------------------------------------------------------------------
  Prioridade              Arquivo                                              Alteração
  ----------------------- ---------------------------------------------------- -----------------------
  P0                      `backend/src/http/server.ts`                         corrigir resolução do
                                                                               Host

  P0                      `backend/src/http/routes/auth.routes.ts`             remover
                                                                               `tenantMiddleware`

  P0                      `backend/src/infra/db/tenant-context.ts`             contexto completo

  P0                      `backend/src/application/auth/login.usecase.ts`      JWT com tenant

  P0                      `backend/src/http/middlewares/auth.middleware.ts`    validar tenant do JWT

  P1                      `frontend/src/pages/login/LoginPage.jsx`             garantir que não
                                                                               escolha tenant

  P1                      `frontend/src/entities/session/api/session.js`       manter API sem tenant
                                                                               explícito

  P1                      `frontend/src/app/providers/auth/AuthProvider.jsx`   sessão sem tenant como
                                                                               autoridade

  P1                      `frontend/src/shared/lib/server.js`                  separar web de desktop

  P1                      `deploy/Caddyfile*`                                  proteger
                                                                               `X-Tenant-Host`

  P2                      `backend/src/infra/realtime/outbox-dispatcher.ts`    `runInTenant()`

  P2                      `backend/src/infra/maintenance.ts`                   `runInTenant()`

  P2                      `backend/src/integrations/ifood/worker.ts`           `runInTenant()`

  P2                      `backend/src/integrations/pagarme/worker.ts`         `runInTenant()`
  ----------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## Conclusão

A correção recomendada **não exige reescrever o sistema de autenticação
nem trocar o modelo de banco**.

A principal mudança é estabelecer uma única regra:

``` text
HOST
  ↓
TENANT
  ↓
ALS
  ↓
DB
```

O login atual de:

``` text
subdomínio → seleção de usuário → PIN
```

pode continuar exatamente como experiência de usuário.

O tenant é decidido **antes** de listar os usuários, e o usuário nunca
escolhe nem informa o tenant. O JWT apenas registra o tenant que já foi
determinado pelo servidor, servindo como segunda barreira contra uso
cruzado de sessões.
