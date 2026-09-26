# Estratégia de organização do frontend — FSD

Status: **aprovado para execução** · Branch: `feature/front-metamorph` · Um commit por fase.

Este documento é a estratégia de refatoração do `frontend/` para FSD
(*Feature-Sliced Design*). As specs de produto continuam mandando em
`docs/01-backend-spec.md` e `docs/02-frontend-spec.md`: aqui só se organiza
o código, sem mudar contrato de API nem comportamento observável — com
exceção do bug de formatação monetária (§7), que é corrigido de propósito.

## 1. Princípios

1. `shared` é para o que **não tem vocabulário de domínio**. Se o nome do
   arquivo só faz sentido no restaurante ("comanda", "gaveta", "entrega"), não
   pertence a `shared`.
2. Direção de dependência: `app → pages → widgets → features → entities → shared`.
   Page nunca é importada por feature.
3. Toda pasta expõe **uma API pública** (`index.js`). Consumidor importa de
   `@/entities/order`, nunca de `@/entities/order/model/orderTotal.js`.
4. **Nenhuma pasta ou barrel vazio.** O barrel `shared/api/index.js` foi
   removido na Fase 0 justamente por ter sido criado "por simetria" e não ter
   consumidor.
5. O projeto é **JavaScript/JSX**. Não se introduzem arquivos `.ts` — não há
   TypeScript no `package.json` e `npx tsc` não está disponível.
6. Fases são **verticais e reversíveis**: cada uma compila, passa nos 50
   testes e pode ser revertida sozinha.

## 2. Diagnóstico

A架构 atual tem três camadas: `app/`, `features/` e `shared/`.

- 17 pastas em `features/`, e **nenhuma delas é uma entity**. Todas são
  telas, abas, ações ou hooks.
- `shared/api/` tem 15 arquivos: **apenas `http.js` é infraestrutura**. Os
  outros 14 são APIs de domínio (`orders.js`, `cash.js`, `delivery`...).
- 131 imports via alias: 98 para `shared`, 32 para `features`, 1 para `app`.
  O gargalo é `shared`, não `features`.
- **Não há ciclos entre features.** Isso permite migrar de baixo para cima.

Cinco pastas escondem mais de um caso de uso:

| Pasta | Casos de uso escondidos |
|---|---|
| `orders` | 5 (abrir comanda, lançar item, revisar carrinho, pagar, QR Pix) |
| `cashdrawer` | 4 (abrir gaveta, sangria/suprimento, fechar gaveta, detalhe) |
| `courier` | 3 (dispatch, deliver, fail) |
| `customer-menu` | 4 (add item, checkout, acompanhar, cancelar) |
| `catalog` | 2+ (produtos, categorias, grupos de produção) |

## 3. Estrutura alvo

```
src/
├── app/
│   ├── providers/auth/       AuthContext + Login (vem do app/router)
│   └── router.jsx
├── pages/                    7 telas compostas por papel
│   ├── pdv/  manager/  kitchen/  cashier/  courier/  customer-menu/  login/
├── widgets/                  blocos de UI reutilizáveis
│   ├── order-card/  status-badge/  money/  modal/  ...
├── features/                 ações do usuário com estado próprio
│   ├── add-item/  close-order/  cancel-order/  open-cash-drawer/
│   ├── cash-movement/  print-kitchen-ticket/  print-receipt/  product-catalog/
├── entities/                 domínio: modelo + API
│   ├── order/  product/  table/  user/  store/  session/
│   ├── delivery/  stock/  cash/  customer/  ifood/  reports/  audit/
└── shared/                   genérico
    ├── api/http.js           único núcleo HTTP
    ├── lib/                  format, theme, uuid (genéricos)
    ├── hooks/                useRealtime
    └── ui/                   Toast, ConfirmModal, Section/Field
```

### Decisões de unificação

- `features/deliveries` + `features/courier` → **`entities/delivery`**. São o
  mesmo agregado (entrega) visto por dois papéis. Elimina 3 duplicações de
  badge de status e de hook.
- `features/inventory` + `features/purchase` → **`entities/stock`**. O ciclo
  `inventory ↔ purchase` (cada um chamando o endpoint do outro) desaparece.
- `VariationModal` (hoje em `shared/components`) volta para
  `entities/product/ui` — o vocabulário é de produto, não genérico.
- `StatusBadge` vai para `entities/order/ui` (status de item) e
  `entities/delivery/ui` (status de entrega), em vez de um componente com
  dicionário fixo.
- `pix.js` (BR Code) → `entities/payment`, não `shared/lib`: é domínio de
  pagamento.

## 4. Classificação atual → destino

| Pasta atual | Destino |
|---|---|
| `app/router.jsx` | `app/` (fica) |
| `auth/AuthContext.jsx` | `app/providers/auth` |
| `auth/Login.jsx` | `pages/login` |
| `orders/OrdersRoot`, `OrderListScreen`, `OrderDetailScreen` | `pages/pdv` |
| `orders/AddItemScreen` | `features/add-item` |
| `orders/NewOrderModal` | `features/open-order` |
| `orders/PaymentModal`, `ReviewCartModal`, `PixQrScreen` | `features/close-order` |
| `orders/order.utils.js` | `entities/order/model` |
| `manager/ManagerApp` | `pages/manager` (registro de abas) |
| `cashier/CashierApp` | `pages/cashier` |
| `courier/CourierApp` | `pages/courier` |
| `kitchen/KitchenDisplay` | `pages/kitchen` |
| `customer-menu/CustomerMenuPage` | `pages/customer-menu` |
| `customer-menu/cartLogic.js` | `entities/cart/model` |
| `cashdrawer/CashDrawerTab` | `widgets/cash-drawer` |
| `cashdrawer/*Modal` (4) | `features/open-cash-drawer`, `cash-movement`, `close-cash-drawer`, `cash-drawer-detail` |
| `catalog/CatalogTab` | `pages/catalog` (aba) |
| `catalog/ProductModal` | `features/product-catalog` |
| `deliveries/` + `courier/` | `entities/delivery` |
| `inventory/` + `purchase/` | `entities/stock` |
| `reports/ReportsTab` | `pages/reports` (aba) |
| `reports/cashReportView.js` | `entities/reports/model` |
| `audit/AuditTab` | `pages/audit` (aba) |
| `ifood/IfoodTab` | `widgets/ifood-sync` |
| `settings/SettingsTab` | `pages/settings` (aba) |
| `users/UsersTab` | `pages/team` (aba) |
| `shared/api/http.js` | `shared/api/` (fica) |
| `shared/api/{orders,cash,...}.js` | `entities/<dominio>/api` |
| `shared/components/{Toast,ConfirmModal,Form}` | `shared/ui` |
| `shared/components/StatusBadge` | `entities/order/ui` |
| `shared/components/VariationModal` | `entities/product/ui` |
| `shared/lib/{format,theme,uuid}` | `shared/lib` (ficam) |
| `shared/lib/money` | `shared/lib` (consolidado, §7) |
| `shared/lib/pix` | `entities/payment` (Fase 3) |

> As abas do gerente (`catalog`, `reports`, `audit`, `settings`, `users`) são
> *pages* no vocabulário FSD porque são compostas pelo `pages/manager` e não
> importadas por features. Só há uma tela por papel em `app/router.jsx`.

## 5. Fases

Cada fase termina com `npm run build`, `npm run test` (50 testes) e
`npm run lint` verdes, e é um commit isolado.

| Fase | Conteúdo | Risco |
|---|---|---|
| **0. Limpeza** | 6 pastas vazias + `shared/api/index.js` morto. ✅ `d1b90ad` | nenhum |
| **1. Sessão** | `auth/AuthContext` → `app/providers/auth`; `auth/Login` → `pages/login`. ✅ `d4edf70` | baixo |
| **2. API → entities** | 14 arquivos de `shared/api` → `entities/<dominio>/api`; mocks de teste atualizados. ✅ | médio |
| **3. Unificação** | UI e modelo das entities: `VariationModal` → `product`, `StatusBadge` → `order`, `DeliveryStatusBadge` → `delivery`, `pix.js` → `payment`, `order.utils` → `order/model`, `cartLogic` → `cart/model`, `cashReportView` → `reports/model`, `ACTION_LABEL` → `audit/model`. ✅ | médio |
| **4. Pages** | 7 telas viram `pages/*`; `router.jsx` só compõe páginas | médio |
| **5. Widgets** | `Money`, `Modal` genérico, `CashDrawerTab`, `IfoodTab` | baixo |
| **6. Features** | 5 pastas com casos de uso escondidos viram `features/*` | **alto** |
| **7. Bugs** | unificar moeda (§7), `cancelled` no badge, `formatMinSec` | baixo |

### O que a Fase 3 entregou

`shared/components` e `shared/lib` passaram a ter só o que é genérico. O que
saiu de lá foi para a entity que é dona do vocabulário:

| Saiu de | Foi para | Por quê |
|---|---|---|
| `shared/lib/pix.js` | `entities/payment/lib` | BR Code é domínio de pagamento |
| `shared/components/StatusBadge.jsx` | `entities/order/ui` | dicionário de status de item de comanda |
| `shared/components/VariationModal.jsx` | `entities/product/ui` | variações são catálogo de produto |
| `features/orders/order.utils.js` | `entities/order/model/order.js` | `orderTotal`, `orderLabel`, `pendingItems` são regra de negócio |
| `features/customer-menu/cartLogic.js` | `entities/cart/model` | chave de linha do carrinho |
| `features/reports/cashReportView.js` | `entities/reports/model` | regra de sessão de caixa |
| `ACTION_LABEL` (dentro de `AuditTab`) | `entities/audit/model` | dicionário de ações do audit log |
| `DeliveryStatusBadge` (dentro de `DeliveriesTab`) | `entities/delivery/ui` | badge de entrega, usado por 2 papéis |

`shared` ficou com 3 primitivas (`Toast`, `Form`, `ConfirmModal`) e 4 libs
genéricas (`format`, `money`, `theme`, `uuid`).

O atalho `features/orders/VariationModal.jsx` (que só re-exportava o
compartilhado) foi removido: agora os dois consumidores importam de
`@/entities/product`.

### Fronteiras agora são testadas

`src/__tests__/fsd-boundaries.test.js` (42 casos) roda em `npm run test` e
falha em cinco situações que o build não pega:

1. `shared/api/` deixar de ter só `http.js`.
2. Arquivo de `shared/` cujo nome carregue vocabulário de domínio
   (`order`, `gaveta`, `entrega`…).
3. Barrel desatualizado — exporta nome que o arquivo não tem, ou deixa de
   re-exportar algo que ele tem. Foi assim que `isOpenSession` e
   `sessionDiff` apareceram faltando em `entities/reports`.
4. Dependência apontando para cima na hierarquia (`shared` → entity,
   feature → `pages`, layer baixa → `app`).
5. Import direto de arquivo interno de entity
   (`@/entities/order/api/order.js`) em vez da API pública.

**Exceção codificada:** `features/*` e `entities/*` podem importar
`@/app/providers/auth`. O contexto de sessão é infraestrutura de app, mas 13
features consomem `useAuth`; colocá-lo em `shared` faria `shared` depender de
`entities`, que é pior. A exceção está listada em `APP_EXCEPTIONS` no teste
com o motivo — qualquer outro import de `@/app` continua falhando, e é o
ponto de revisão caso sessão vire entity.

### O que a Fase 2 entregou

`shared/api/` ficou com **um único arquivo**, `http.js`. As 14 APIs de
domínio viraram 16 entities com barrel próprio:

| Entity | Aggregate | Entity | Aggregate |
|---|---|---|---|
| `order` | comandas + pedidos públicos | `delivery` | entregas (gerente + entregador) |
| `product` | produtos + cardápio público | `stock` | estoque, compras, fornecedores, valorização |
| `category` | categorias | `cash` | gaveta |
| `kitchen-group` | estações de produção | `store` | loja e settings |
| `table` | mesas | `user` | equipe |
| `customer` | clientes (interno + público) | `ifood` | integração iFood |
| `cart` | carrinho server-side | `reports` | relatório de vendas |
| `audit` | trilha de auditoria | `session` | login |

Três divisões foram necessárias porque os arquivos antigos empacotavam
agregados diferentes: `catalog.js` virou `product` + `category` +
`kitchen-group`; `orders.js` virou `order` + `table`; `public.js` virou
`product/public` + `customer/public` + `order/public` + `cart`. As fusões
inversas foram `courier.js` → `delivery` e `purchase.js` → `stock`, o que
elimina o ciclo `inventory ↔ purchase` (cada aba chamava o endpoint da outra).

Endpoints públicos (`/public/*`) ficam em `api/public.js` dentro da entity
correta, separando **domínio** de **superfície de autenticação**.

Os 80 exports foram conferidos programaticamente contra o código real: cada
nome declarado em barrel existe no arquivo que o define.

Ordem não é negociável: **não se move `orders/*` antes de `pages/`** (Fase 6
é a última justamente por isso).

## 6. Regras de verificação

1. `npm run build` **não** pega `ReferenceError` de import perdido em módulo
   não importado pela árvore de produção. O teste de integração
   `CustomerMenuPage.test.jsx` é a rede de segurança real.
2. Fases 2 e 3 quebram os `vi.mock` de API. Os mocks foram migrados para
   `vi.mock("@/entities/x", async (importOriginal) => ({ ...(await importOriginal()), ... }))`:
   um mock declarativo da barrel **esconde o resto da entity** — foi o que
   quebrou `ProductCard` (usa `lineKey`/`productQty` de `@/entities/cart`) e
   `ReportsTab` (usa `buildCashReportView` de `@/entities/reports`). O
   padrão `importOriginal` é obrigatório ao mockar barrel que também expõe
   UI ou model.
3. `src/__tests__/fsd-boundaries.test.js` é a rede de segurança estrutural
   (42 casos): barrels consistentes, `shared` sem vocabulário de domínio,
   direção de dependências e import só pela API pública.
4. `npm run lint` (oxlint) tem 2 warnings pré-existentes em
   `AuthContext.jsx:79` e `Toast.jsx:3` (`only-export-components`) e 1 em
   `Login.jsx:91` (`exhaustive-deps`). Não são Blocking.
5. `http.js` guarda estado global mutável (`authToken`, `onUnauthorized`).
   Isso **força** `vi.mock` de módulo inteiro nos testes; injetar dependência
   é o que torna `entities/*/api` testável de unidade, mas é um passo
   separado e opcional.

## 7. Bug de moeda (corrigido de propósito)

Existem 5 implementações de `money` e 7 usos inline de `.toFixed(2)`.

`shared/lib/money.js` usa `Intl.NumberFormat("pt-BR")` → `R$ 1.234,56`.
`features/orders/order.utils.js:6` faz `` `R$ ${Number(v).toFixed(2)}` `` →
`R$ 1234.56`. Idem em `cashdrawer` (4×) e `reports`.

Resultado hoje: **o mesmo valor aparece com separador de milhar no cardápio
do cliente e sem no garçom e no caixa**, inclusive em string de usuário
(`PaymentModal.jsx:100`: "Falta R$ ${money(remaining)}").

Decisão: consolidar tudo em `formatBRL` (pt-BR). Isso **muda o que o garçom e
o caixa veem** — de `R$ 1234.56` para `R$ 1.234,56`. É o comportamento
correto em PT-BR e foi aprovado, mas é mudança visível: vale smoke manual dos
perfis garçom e caixa.

**Exceções (não unificar):**
- `PaymentModal.jsx:68-90` — `.toFixed(2)` monta payload numérico da API.
- `pix.js:58` — campo 54 do BR Code tem formato fixo.
- `maskCurrencyInput`/`parseBRL` já usam `brl` corretamente.

## 8. Fora de escopo

- Introduzir TypeScript, React Hook Form, TanStack Query, Zustand, axios.
  O `AGENTS.md` proíbe lib de estado ("server-authoritative"): a refatoração
  é **apenas de camadas**, mantendo JSX e o modelo de dados atual.
- Trocar `fetch` por axios ou introduzir cache de cliente.
- Separar `ManagerApp` em rotas próprias (hoje é um registro de abas; a spec
  §4.4 pede isso, mas é decisão de produto, não de arquitetura).
