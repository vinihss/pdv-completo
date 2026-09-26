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
| `catalog/CatalogTab` | `pages/manager/tabs/catalog` |
| `catalog/ProductModal` | `pages/manager/tabs/catalog` (Fase 6: `features/product-catalog`) |
| `deliveries/` + `courier/` | `entities/delivery` + `pages/manager/tabs/deliveries` |
| `inventory/` + `purchase/` | `entities/stock` + `pages/manager/tabs/{inventory,purchase}` |
| `reports/ReportsTab` | `pages/manager/tabs/reports` |
| `reports/cashReportView.js` | `entities/reports/model` |
| `audit/AuditTab` | `pages/manager/tabs/audit` |
| `ifood/IfoodTab` | `pages/manager/tabs/ifood` |
| `settings/SettingsTab` | `pages/manager/tabs/settings` |
| `users/UsersTab` | `pages/manager/tabs/users` |
| `orders/OrdersRoot`, `OrderListScreen`, `OrderDetailScreen`, `useOrders` | `widgets/order-board` |
| `orders/` (os 5 casos de uso restantes) | `features/orders` (Fase 6) |
| `shared/api/http.js` | `shared/api/` (fica) |
| `shared/api/{orders,cash,...}.js` | `entities/<dominio>/api` |
| `shared/components/{Toast,ConfirmModal,Form}` | `shared/ui` |
| `shared/components/StatusBadge` | `entities/order/ui` |
| `shared/components/VariationModal` | `entities/product/ui` |
| `shared/lib/{format,theme,uuid}` | `shared/lib` (ficam) |
| `shared/lib/money` | `shared/lib` (consolidado, §7) |
| `shared/lib/pix` | `entities/payment` (Fase 3) |

> **Não confundir três coisas diferentes.** Só há uma tela por papel em
> `app/router.jsx`, e por isso existem 7 `pages/`. As 10 abas do gerente
> (`catalog`, `reports`, `audit`, `settings`, `users`, `deliveries`, `ifood`,
> `inventory`, `purchase`, `cashdrawer`) **não são pages**: são conteúdo
> privado da tela do gerente e vivem em `pages/manager/tabs/` (`cashdrawer`
> virou widget, ver Fase 4). E `cashdrawer` é widget — e não page — porque é
> reusado por `pages/cashier`. Nenhuma delas é feature: feature é ação do
> usuário com estado próprio, não painel administrativo.

## 5. Fases

Cada fase termina com `npm run build` e `npm run test` verdes, `npm run lint`
sem warning novo, e é um commit isolado. O número de testes de fronteira
cresce a cada fase, porque a contagem acompanha quantos barrels existem:
hoje são 137 no total (100 de comportamento + 37 de arquitetura).

| Fase | Conteúdo | Risco |
|---|---|---|
| **0. Limpeza** | 6 pastas vazias + `shared/api/index.js` morto. ✅ `d1b90ad` | nenhum |
| **1. Sessão** | `auth/AuthContext` → `app/providers/auth`; `auth/Login` → `pages/login`. ✅ `d4edf70` | baixo |
| **2. API → entities** | 14 arquivos de `shared/api` → `entities/<dominio>/api`; mocks de teste atualizados. ✅ | médio |
| **3. Unificação** | UI e modelo das entities: `VariationModal` → `product`, `StatusBadge` → `order`, `DeliveryStatusBadge` → `delivery`, `pix.js` → `payment`, `order.utils` → `order/model`, `cartLogic` → `cart/model`, `cashReportView` → `reports/model`, `ACTION_LABEL` → `audit/model`. ✅ | médio |
| **4. Pages** | 7 telas viram `pages/*`; 10 abas do gerente viram `pages/manager/tabs/`; blocos compartilhados viram widgets. ✅ | médio |
| **5. Widgets + moeda** | `Modal` genérico; unificação de moeda → `formatBRL` única. ✅ | baixo |
| **6. Features** | 5 pastas com casos de uso escondidos viram `features/*` | **alto** |
| **7. Bugs** | `cancelled` no `StatusBadge`; `formatMinSec` órfão e `minutesSince` duplicado. ✅ | baixo |

### O que a Fase 4 entregou

As 6 telas restantes viraram `pages/*` (com `login` da Fase 1, são 7) e
`app/router.jsx` passou a importar **só pages**. As 10 abas do gerente foram
para `pages/manager/tabs/*`: são conteúdo privado da tela do gerente, e não
ações do usuário (feature) nem blocos reusados (widget) — antes só pareciam
features porque estavam em `features/`.

Duas extrações de widget foram forçadas pela regra *page não importa page*:

| Widget | Por que é widget | Consumido por |
|---|---|---|
| `widgets/order-board` | o bloco de comandas do garçom **é** a aba "Comandas" do gerente | `pages/pdv`, `pages/manager` |
| `widgets/cash-drawer` | gaveta é a tela do perfil caixa **e** a aba "Caixa" do gerente | `pages/cashier`, `pages/manager` |

`pages/pdv/PdvPage.jsx` é deliberadamente fino: renderiza `<OrderBoard />`. A
screen do garçom não tem lógica própria além de ser a rota do waiter.

`features/` ficou com **uma** pasta (`orders`, com os 5 casos de uso: abrir
comanda, lançar item, revisar carrinho, pagar, QR Pix) — é o alvo da Fase 6.

### O que a Fase 7 entregou

**`StatusBadge` não conhecia `cancelled`.** `cancelOrder` marca como `cancelled`
todo item ainda não entregue (`order.usecases.ts`), e o `orderTotal` do front já
os exclui da soma — mas o badge caía no fallback e renderizava a string crua
**"cancelled"** (em inglês) num badge cinza de "Em preparo". Agora tem rótulo
"Cancelado" e classe vermelha, com teste próprio (3 casos) que fixa inclusive a
regressão do texto em inglês.

**Duração de tempo tinha três implementações.** `shared/lib/format.js` tinha
`formatMinSec` (`"3m 20s"`) que **ninguém usava**; a cozinha tinha uma cópia
local com `"3:20"`, que é o formato de cronômetro correto para a tela. O morto
foi removido, a cozinha passou a importar `minutesSince` do shared (elimina a
cópia e ganha a guarda de `null`), e manteve o formatador `mm:ss` local — é
específico da tela, não algo para o shared.

Verificados e **já estavam corretos** (nada a fazer): `usePublicRealtime` já é
um hook único em `shared/hooks` (não há duplicata), e o toggle do iFood já entra
no payload, porque `handleSave` envia o form inteiro para `updateStoreSettings`.

### Robustez: `toDate()` sem guarda (corrigido)

`shared/lib/format.js::toDate` devolve `null` para timestamp ausente ou
inválido, e 7 call sites faziam `toDate(x).toLocaleString()` direto — em
`ReportsTab`, `CashDrawerTab`, `CashDrawerDetailModal` e `PrintReceipt`. Com
`openedAt`/`closedAt`/`createdAt` nulo, isso lançava em vez de renderizar.
Agora é `toDate(x)?.toLocaleString() ?? "—"` em todos. **O formato exibido não
mudou**: a decisão foi guarda mínima com fallback, em vez de migrar para
`formatDateTime` (que padronizaria, mas alteraria o que o usuário vê em caixa
e relatório). O guarda `x && toDate(x)…` que existia em alguns lugares ficou
redundante e foi removido — `toDate(null)` já devolve `null`, então o `?? "—"`
cobre os dois casos.

### Estabilidade da suíte

`vitest.config.js` agora usa `pool: "vmThreads"`, a sugestão que o próprio
vitest imprimia ao final das execuções. Antes, `jsdom` era criado uma vez por
arquivo (7–9 instâncias, ~12s) e a suíte chegou a reportar arquivos inteiros
falhando sob pressão de memória da máquina, **sem falha determinística** — não
reproduzi em 20+ execuções, mas também não posso provar que era só contenção de
recursos. Com `vmThreads` o ambiente é criado uma vez por worker: 8 execuções
seguidas passaram 90/90 e a duração caiu de ~7,3s para ~4,5s. O alias
`@inspector/react` foi replicado do `vite.config.js` para o `vitest.config.js`,
senão o scan de dependências reclamava ao encarar `src/main.jsx`.

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

`shared` ficou com 5 primitivas (`Toast`, `Form`, `ConfirmModal`, `Modal`,
`ScreenHeader`) e 4 libs genéricas (`format`, `money`, `theme`, `uuid`).

O atalho `features/orders/VariationModal.jsx` (que só re-exportava o
compartilhado) foi removido: agora os dois consumidores importam de
`@/entities/product`.

### Fronteiras agora são testadas

`src/__tests__/fsd-boundaries.test.js` (37 casos) roda em `npm run test` e
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
6. `page` importando `page` — o que duas pages compartilham tem que ser
   widget (regra introduzida na Fase 4, depois de `pages/manager` passar a
   importar `pages/pdv`).

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

### Convenção de overlay (Fase 5)

Toda sobreposição do app passa por uma de três primitivas de `shared/components`:

| Primitiva | Quando | Comportamento |
|---|---|---|
| `Modal` | formulário/carrinho/detalhe (18 usos) | **tela cheia em qualquer device** (o tablet do garçom é o alvo): cabeçalho fixo com título e **X à direita**, corpo rolável, `footer` de ação sempre visível. Fecha por X, **Esc** ou **arrastando para baixo** (toque) |
| `ScreenHeader` | tela que já é fullscreen (`OrderDetailScreen`, `AddItemScreen`) | mesma métrica do `Modal`, com o controle **à esquerda** (é navegação, não descarte) e **Esc** para voltar |
| `ConfirmModal` | confirmação binária curta | **card centralizado** — o peso do aviso vem do card pequeno; Esc cancela; `destructive` para exclusão/cancelamento |

Regras que caem disso:

- **Não existe overlay ad-hoc.** `fixed inset-0 bg-black/70` só aparece dentro
  de `ConfirmModal` — foi o que o `rg` acusou ao final da migração.
- **Esc é sempre "a camada de cima fecha"** — via `useEscapeLayer`
  (`shared/hooks/useEscapeLayer.js`). Um listener por componente resolveria
  pela ordem de *registro*, e ela não é a ordem visual: o React roda efeito de
  filho antes do pai (num `Modal` dentro de outro, quem registra por último é o
  de fora) e o header da tela pode ter registrado antes de um modal que abriu
  depois. A pilha compara os elementos por `compareDocumentPosition` (overlay é
  `fixed` com z-index igual, então o último da árvore é o último pintado) e
  entrega a tecla só ao topo. Captura + `stopImmediatePropagation` + guarda de
  `repeat`/`defaultPrevented` vivem na pilha.
- **`Modal` trava o scroll do fundo** (`document.body.style.overflow`) e
  restaura no unmount. Não havia nada disso no app: o corpo rolava por trás.
- **Gesto de descarte é conservador de propósito**: fecha com arrasto > 120px
  ou flick > 40px **e** > 0,6px/ms, com trava de eixo em 8px (diagonal é
  scroll, não descarte) e com o corpo já rolado pertence ao scroll nativo.
- `Modal` **não pode** usar `formatBRL`/`.toFixed(2)`: é primitiva de `shared`.
  Os modais de dinheiro formatam no pai e recebem string/valor já pronto.
- `PaymentModal.jsx` e `CloseCashDrawerModal.jsx` **ficam onde estão** despite o
  nome: o `fsd-boundaries.test.js` tem allowlist (`MONEY_ALLOWED`) para os dois.

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
   (37 casos): barrels consistentes, `shared` sem vocabulário de domínio,
   direção de dependências e import só pela API pública.
4. `npm run lint` (oxlint) tem 2 warnings pré-existentes em
   `AuthProvider.jsx:79` e `Toast.jsx:3` (`only-export-components`) e 1 em
   `public/sw.js` (`no-unused-vars`). Não são blocking. O
   `exhaustive-deps` de `LoginPage.jsx` foi resolvido com `useCallback` nos
   handlers de PIN.
5. `http.js` guarda estado global mutável (`authToken`, `onUnauthorized`).
   Isso **força** `vi.mock` de módulo inteiro nos testes; injetar dependência
   é o que torna `entities/*/api` testável de unidade, mas é um passo
   separado e opcional.

## 7. Bug de moeda (corrigido — Fase 5)

**Antes:** 5 implementações de `money` e 7 usos inline de `.toFixed(2)`.
`shared/lib/money.js` usava `Intl.NumberFormat("pt-BR")` → `R$ 1.234,56`, e
`order.utils.js:6` fazia `` `R$ ${Number(v).toFixed(2)}` `` → `R$ 1234.56`.
Idem em `cashdrawer` (4×) e `reports`. Resultado: **o mesmo valor aparecia
com separador de milhar no cardápio do cliente e sem no garçom e no caixa**,
inclusive em string de usuário (`PaymentModal`: "Falta R$ ${money(remaining)}").

**Depois:** `formatBRL` é a única implementação. `money` foi apagado — tanto
o local de `order/model` quanto o alias de `shared/lib` — e os 4 `fmt` locais
do `cash-drawer`, o `fmtMoney` do `cashReportView` e os 6 inline do
`ReportsTab` delegam para ela. Isso **muda o que o garçom e o caixa veem**,
de `R$ 1234.56` para `R$ 1.234,56`: comportamento correto em PT-BR, aprovado
explicitamente. Coberto por teste automatizado; **falta o smoke manual dos
perfis garçom e caixa** para confirmar visualmente.

Duas asserções de teste foram atualizadas para o formato novo, e o teste de
`fmtMoney` passou a fixar o separador de milhar também. Note que o `Intl`
pt-BR usa **espaço não separável** (U+00A0) entre `R$` e o número: comparar
com um espaço comum falha, e é por isso que o literal do teste usa `\u00a0`.

**Exceções (não unificar), agora listadas no teste de fronteiras:**
- `PaymentModal.jsx` — `.toFixed(2)` monta o payload numérico da API
  (`amount`/`received`), que o backend parseia como decimal.
- `pix.js:58` — campo 54 do BR Code tem formato fixo de 2 casas.
- `CloseCashDrawerModal.jsx` — valor inicial de um `<input type="number">`;
  `"1.234,56"` quebraria o `Number()` do onChange.
- `maskCurrencyInput`/`parseBRL` já usam `brl` corretamente.

O teste `moeda tem fonte única` (2 casos) falha se surgir um `toFixed(2)` fora
dessas três exceções, ou um `money`/`fmtMoney`/`fmt` local novo.

## 8. Fora de escopo

- Introduzir TypeScript, React Hook Form, TanStack Query, Zustand, axios.
  O `AGENTS.md` proíbe lib de estado ("server-authoritative"): a refatoração
  é **apenas de camadas**, mantendo JSX e o modelo de dados atual.
- Trocar `fetch` por axios ou introduzir cache de cliente.
- Separar `ManagerApp` em rotas próprias (hoje é um registro de abas; a spec
  §4.4 pede isso, mas é decisão de produto, não de arquitetura).
