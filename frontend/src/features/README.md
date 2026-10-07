# Arquitetura do frontend (PDV)

Estrutura **FSD** (*Feature-Sliced Design*), pensada para facilitar extensão e
personalização — inclusive por agentes de IA. Convenções e mapa de arquivos em
`docs/agent-frontend.md` e `docs/agent-frontend-map.md`; execução dos testes em
`docs/agent-testing.md`.

Regra de ouro: **cada camada só importa de camadas abaixo dela**, e `shared`
só guarda o que não tem vocabulário de domínio.

## Estrutura

```
src/
├── app/                  # bootstrap: router + providers
│   ├── router.jsx        # AppFrame e mapa de telas por papel
│   └── providers/auth/   # AuthProvider, useAuth
├── pages/                # 7 telas compostas por papel
│   ├── pdv/              # garçom
│   ├── manager/          # gerente (registro de abas)
│   │   └── tabs/         # conteúdo privado da tela do gerente
│   ├── kitchen/  cashier/  courier/
│   ├── customer-menu/    # página pública de pedido (/pedido)
│   └── login/
├── widgets/              # blocos de UI reusados por 2+ pages
│   ├── order-board/      # comandas: garçom e aba "Comandas" do gerente
│   └── cash-drawer/      # gaveta: perfil caixa e aba "Caixa" do gerente
├── features/             # ações do usuário com estado próprio
│   └── orders/           # abrir comanda, lançar item, revisar, pagar, QR Pix
├── entities/             # domínio: api + model + ui
│   ├── order/ product/ category/ kitchen-group/ table/
│   ├── delivery/ stock/ cash/ customer/ store/ user/ session/
│   ├── cart/ payment/ reports/ audit/ ifood/
├── shared/               # genérico, sem domínio
│   ├── api/http.js       # ÚNICO núcleo de rede (request, upload, token)
│   ├── components/       # primitives: Button, PageHeader, EmptyState, Modal...
│   ├── hooks/            # useRealtime
│   └── lib/              # format, money, theme, uuid
└── __tests__/            # fsd-boundaries.test.js: regras de arquitetura
```

## Convenções (o que agentes devem memorizar)

- **Direção de dependência:** `app → pages → widgets → features → entities →
  shared`. `page` nunca é importado por `page`; o que duas pages compartilham
  vira widget. `shared` nunca importa camada de domínio.
- **Exceção única:** `features/*` e `entities/*` podem importar
  `@/app/providers/auth` (o `useAuth` é consumido por 13 features). Está
  listado em `APP_EXCEPTIONS` no teste de fronteiras.
- **Imports sempre via alias `@`** (configurado em `vite.config.js` e
  `jsconfig.json`). Ex.: `import { openOrder } from "@/entities/order"`.
- **Uma API pública por pasta** (`index.js`). Nunca importe arquivo interno:
  `@/entities/order`, e não `@/entities/order/api/order.js`.
- **Barrel sempre em dia.** O teste de fronteiras falha se um `index.js`
  declarar um nome que o arquivo não exporta, ou deixar de re-exportar algo.
- **API de domínio mora na entity**, nunca em `shared/api`. Só
  `shared/api/http.js` é infraestrutura.
- **Server-authoritative**: mutation `await` + reload via REST; WebSocket
  (`useRealtime`) só para refresh direcionado. Sem otimismo.
- **Sem lib de estado** (Redux/Zustand/React Query) e **sem TypeScript** — o
  projeto é JSX puro.

## Onde colocar coisa nova

| O que é | Vai em |
|---|---|
| Tela montada pelo router | `pages/<papel>/` |
| Conteúdo privado de uma tela | `pages/<papel>/tabs/` |
| Bloco reusado por 2+ telas | `widgets/<bloco>/` |
| Ação do usuário (abrir, lançar, pagar) | `features/<acao>/` |
| Conceito de negócio + seus endpoints | `entities/<dominio>/` |
| Utilidade sem domínio | `shared/lib/`, `shared/components/`, `shared/hooks/` |

## Cliente HTTP

`shared/api/http.js` é o **único** módulo de infraestrutura de rede (token,
unauthorized, `request`/`upload`). A API de cada agregado mora em
`entities/<dominio>/api/`, importada pela API pública da entity
(`import { listStock } from "@/entities/stock"`). Endpoints `/public/*` ficam
em `api/public.js` dentro da entity correta, separando domínio de superfície
de autenticação.

## Testes

`npm run test` roda vitest (jsdom + Testing Library). Além dos testes de
comportamento, `src/__tests__/fsd-boundaries.test.js` (35 casos) falha se a
arquitetura quebrar: `shared/api` deixando de ter só `http.js`, nome de
domínio em `shared`, barrel desatualizado, dependência apontando para cima,
import de arquivo interno de entity, ou page importando page.

Ao mockar uma entity em teste, use o padrão-preservar:

```js
vi.mock("@/entities/cart", async (importOriginal) => ({
  ...(await importOriginal()),
  getPublicCart: () => Promise.resolve(null),
}));
```

Um mock declarativo da barrel **esconde o resto da entity** (UI e model) e
quebra o render.
