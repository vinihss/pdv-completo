# Convenções Frontend

Guia detalhado para agentes que trabalham no frontend (`frontend/`).

## Arquitetura FSD (Feature-Sliced Design)

```
src/
├── app/                  # bootstrap: router + providers
│   ├── boot/             # BootGate, bootSequence (desktop)
│   └── providers/        # auth, nav, alerts, app-config, order-focus
├── pages/                # telas compostas por papel
│   ├── pdv/              # garçom
│   ├── manager/          # gerente (mapa de abas)
│   ├── kitchen/          # cozinha
│   ├── cashier/          # caixa
│   ├── courier/          # entregador
│   ├── customer-menu/    # página pública (/pedido)
│   └── login/            # login por PIN
├── widgets/              # blocos de UI reusados por 2+ pages
│   ├── order-board/      # comandas (garçom + gerente)
│   ├── cash-drawer/      # gaveta (caixa + gerente)
│   ├── app-menu/         # menu principal (accordion)
│   └── alert-bell/       # sino de alertas
├── features/             # ações do usuário com estado próprio
│   └── orders/           # abrir comanda, lançar item, revisar, pagar, QR Pix
├── entities/             # domínio: api + model + ui
│   ├── order/ product/ category/ kitchen-group/ table/
│   ├── delivery/ stock/ cash/ customer/ store/ user/ session/
│   ├── cart/ payment/ reports/ audit/ ifood/ alert/
│   └── printer/ updater/ whatsapp/
├── shared/               # genérico, sem domínio
│   ├── api/http.js       # ÚNICO núcleo de rede
│   ├── components/       # Modal, Drawer, ConfirmModal, Toast, Form, etc.
│   ├── hooks/            # useRealtime, useEscapeLayer, useBodyScrollLock, useFocusTrap
│   └── lib/              # platform, appConfig, uuid, audio, pix, format, money, theme
└── __tests__/            # fsd-boundaries.test.js
```

**Regra de ouro**: `app → pages → widgets → features → entities → shared`. Nunca ao contrário.

## Direção de dependência

- `page` nunca é importado por `page`; o que duas pages compartilham vira widget
- `shared` nunca importa camada de domínio
- **Exceção única**: `features/*` e `entities/*` podem importar `@/app/providers/auth` (o `useAuth` é consumido por 13 features). Está listado em `APP_EXCEPTIONS` no teste de fronteiras

## Imports

- **Sempre via alias `@`** (configurado em `vite.config.js` e `jsconfig.js`)
- Ex.: `import { openOrder } from "@/entities/order"`
- **Uma API pública por pasta** (`index.js`). Nunca importe arquivo interno: `@/entities/order`, e não `@/entities/order/api/order.js`
- **Barrel sempre em dia**. O teste de fronteiras falha se um `index.js` declarar um nome que o arquivo não exporta, ou deixar de re-exportar algo

## Sem lib de estado

- **Server-authoritative**: mutation `await` + reload via REST
- WebSocket (`useRealtime`) só para refresh direcionado
- Sem otimismo
- Sem Redux/Zustand/React Query
- Sem TypeScript — o projeto é JSX puro

## Realtime

- Hook: `useRealtime(token, rooms, onEvent, onReconnect)`
- Token vai como **subprotocol** (`Sec-WebSocket-Protocol`), nunca na query string
- Rooms: `waiter:{userId}`, `kitchen-display`, `cash-drawer`, `deliveries`, `inventory`, `alerts`, `alerts:<papel>`
- **Nunca** emitir evento relevante só para `table:{id}` — nenhum client assina esse room
- `onReconnect` dispara só a partir da segunda abertura (a primeira é a montagem, que já carregou)

## Mutations

- Aguardar e então recarregar; sem otimismo
- Tratar erros de domínio com toasts (`src/components/Toast.jsx`)

## Botão de ação fora do `<form>`

Modais com footer irmão do form (`ProductModal`, `SupplierModal`, `MovementModal`, ...) devem vincular o botão por `form="<idForm>"` + `noValidate` no form — clique e Enter passam a submeter de verdade.

## UI em PT-BR

- Ícones via `lucide-react`
- Estilos com Tailwind 4 (CSS-first)

## Variações de produto

- Contrato único em `src/domain/variations.ts` (backend) e `VariationGroup` espelhado no menu público
- O modal é **compartilhado** (`src/shared/components/VariationModal.jsx`, re-exportado em `src/features/orders/`)
- O garçom usa sem campo de observação
- Regra de linha: chave = produto + variações, então o mesmo produto com escolhas diferentes são linhas separadas
- Cliente valida no modal (UX) **e** o `POST /public/orders` barra grupo obrigatório ausente/inválido com 422 antes de qualquer escrita
- Lógica pura do carrinho público em `src/features/customer-menu/cartLogic.js` (testada sem DOM)

## Destaques da página pública

- `product.featured` (coluna no `0001_init.sql`, default `false`) alimenta a vitrine "Destaques" do `/pedido`
- O produto continua na sua categoria (comportamento iFood)
- Marcado no cadastro (`ProductModal`, toggle "Em destaque na página de pedidos")
- O campo só vai no payload quando o toggle existe — um edit com `uses_delivery` off não apaga a curadoria

## Ficha completa antes de adicionar

- **Não existe botão de "+"** nos cards — o clique abre o `VariationModal` compartilhado com `imagePath` + `showQuantity`
- Os props são opcionais e desligados por padrão (o garçom continua com só as opções)
- `onConfirm(sel, notes, qty)` só recebe qty com `showQuantity`
- `ProductStepper` foi removido (com `productStepperState`/`baseLineKey` do cartLogic)
- O card mostra badge "N no carrinho" e as linhas com variação (botões de linha levam produto + variação no `aria-label`)

## Sem painel de carrinho fixo na lateral

- O "Seu pedido" sticky do desktop foi removido — página coluna única
- Carrinho aberto pela barra `fixed` (full-width no celular, `lg:right-8 lg:w-80` no desktop, cantos inferiores)
- Teste de integração da página (`CustomerMenuPage.test.jsx`) é o que pega ReferenceError de import perdido

## Sobreposição tem dono

**Nada de overlay ad-hoc** — se aparecer `fixed inset-0 bg-black/70` fora do `ConfirmModal` ou do `Drawer`, volta para um deles.

### Modal

- **Tela cheia em qualquer device** (o tablet do garçom é o alvo)
- Cabeçalho fixo com título e **X à direita**, corpo rolável, `footer` de ação sempre visível
- Fecha por X, **Esc** ou **arrasto para baixo**
- Cobre os ~18 modais do app
- **Não pode formatar dinheiro** (`formatBRL`/`.toFixed(2)` é proibido em `shared`): o pai formata e passa pronto
- `PaymentModal.jsx` e `CloseCashDrawerModal.jsx` **não** movem de lugar — estão no allowlist `MONEY_ALLOWED` do `fsd-boundaries.test.js`

### Drawer

- Overlay **lateral** (painel que entra pela esquerda), o dono do menu principal no celular
- Só a entrada é animada (`slide-in-left`)

### ScreenHeader

- Telas que **já** são fullscreen (`OrderDetailScreen`, `AddItemScreen`)
- Mesma métrica do `Modal`, controle **à esquerda** (é navegação, não descarte) e Esc para voltar

### ConfirmModal

- Confirmação binária curta continua **card centralizado** (o peso do aviso vem do card)
- Esc cancela, `destructive` para exclusão

### Regras compartilhadas

- O Esc passa por `useEscapeLayer` (`src/shared/hooks/useEscapeLayer.js`), que guarda uma **pilha de camadas** e entrega a tecla só ao topo
- Captura + `stopImmediatePropagation` + guarda de `repeat`/`defaultPrevented`
- `Modal` e `Drawer` travam o scroll do fundo e restauram no unmount
- Ambos usam os hooks compartilhados `useBodyScrollLock`/`useFocusTrap` (não reimplementar isso por conta própria)
- Gesto de descarte conservador: > 120px ou flick > 40px **e** > 0,6px/ms, trava de eixo em 8px, e corpo já rolado pertence ao scroll nativo

### Section

- `Section` (`shared/components/Form.jsx`) aceita `collapsed`/`onToggle` opcionais
- Com eles o cabeçalho vira botão de colapso (accordion de seção)
- Sem, é estático — não recriar esse comportamento ad-hoc

## Menu principal (accordion)

- **Desktop (`lg`+)**: coluna de largura fixa ao lado do conteúdo — `w-72` (18rem) para quem tem o que expandir (o gerente) e **trilho de `w-16`** (4rem) para os perfis de tela única (garçom, cozinha, caixa, entregador)
- `sticky top-14`, porque o header da casca é `h-14`
- **Mobile**: `Drawer` de tela cheia, aberto pelo botão `Menu` do header (`lg:hidden`, `aria-controls="app-menu-painel"`)
- Escolher uma tela fecha o painel; o rodapé do painel tem só a identidade de quem está logado — o "Sair" é um botão circular no canto direito do header e **não** é duplicado aqui

### Regra de degeneração

- Seção com **um** item não vira cabeçalho — o próprio item é a linha
- Menu sem nenhuma seção com 2+ itens vira trilho de ícones
- A seção da tela ativa começa aberta; mais de uma pode ficar aberta ao mesmo tempo

### NavProvider

- **Quem guarda a tela ativa é o `NavProvider`** (`app/providers/nav/`), não a página
- Persiste por papel em `sessionStorage` (`pdv:nav:<role>`)
- `id` guardado que não existe mais (toggle desligado) cai no primeiro item
- A antiga barra de abas do gerente **saiu**: `ManagerApp` é um mapa `SCREENS[activeId] ?? SCREENS.orders`
- O `AccordionMenu` soma os badges da seção no cabeçalho, para o sinal continuar visível com a seção recolhida
- `shared/components/AccordionMenu.jsx` é burro de propósito: recebe as seções prontas e não sabe o que é comanda, estoque ou gerente

## Avatar das pessoas

- `UserAvatar` (`shared/components`) desenha a foto quando existe e as iniciais quando não
- Usada na grade do login, na tela do PIN e na identidade do menu
- `photoPath` vem em `GET /auth/users` e em `POST /auth/login` (a sessão guarda o objeto inteiro em `sessionStorage`)

## Login por PIN

- Duas vias de entrada, mesma regra (só dígitos, corte em 6): o keypad na tela e um input real sobre a linha de pontos com `inputMode="numeric"` + `autoComplete="one-time-code"`
- O envio é **explícito** — botão "Entrar" ou `Enter`; completar 6 dígitos **não** loga (PIN vai de 4 a 6) e o botão desabilita abaixo de 4
- `Esc` volta para a seleção

## Busca sem acentos

- O backend usa a extensão `unaccent` do Postgres (migration `0003`) + normalização no app (`normalizeAccents` em `backend/src/domain/text.ts`)
- Produtos, estoque e clientes buscam por nome sem distinguir acentos/case

## PWA / build

- Service worker registrado só em produção (`src/main.jsx`)
- `sw.js` ignora `/api` e `/realtime` (sempre rede) e faz cache-first de `/assets/*`

## App desktop (Tauri, Windows)

O mesmo `App.jsx` roda como PWA no navegador e como app Windows. A distinção está toda em `src/shared/lib/platform.js` (`isDesktop()`, `isTauri()`) e `src/shared/lib/appConfig.js` (`apiBase()`, `wsEndpoint()`).

> **STATUS — Tauri desacoplado do frontend.** `frontend/` é só a aplicação web
> (e o bundle que os apps standalone servem). O app v1 (`frontend/src-tauri/`,
> `com.pdvapp.desktop`, em produção) continua no repo, porém em modo de
> manutenção e como **diretório desacoplado**:
>
> - **CLI do Tauri na raiz do repo** — `node_modules/.bin/tauri`
>   (`@tauri-apps/cli` no `package.json` da raiz). Nada disso se instala mais em
>   `frontend/node_modules`; para o v1, rode a CLI com cwd = `frontend/`
>   (ex.: `cd frontend && ../node_modules/.bin/tauri dev`).
> - **Build do v1 é manual**: `bash scripts/build/build-app.sh`
>   (aceita `--release`, `--bundles <tipo>`, `--appimage-docker`; detalhe em
>   `docs/11-desktop-instalador.md` §8). Os scripts `desktop:*` saíram do
>   `frontend/package.json` — as deps de **runtime** `@tauri-apps/*` seguem lá,
>   só a CLI saiu.
> - **Não há mais crate dentro do app web**: o `frontend/` (Vite) não compila
>   Rust nenhum; o crate do v1 é o de `frontend/src-tauri/`, com `Cargo.lock`
>   próprio (fora do workspace da raiz). O version mismatch que importa é
>   `frontend/package.json` × esses crates — ver "Versão JS×Rust" abaixo.

### Boot gate

- **Obrigatório no desktop**: `src/app/boot/` verifica update e conectividade antes de abrir (`BootGate` → `bootSequence.js`, estado puro testável)
- Regra que não muda: **falha de update não bloqueia, API fora do ar bloqueia**
- A ordem depende de `mode`: `cloud` faz health check antes do update, `local` faz update antes

### Sidecar (SAIU do build)

- **Removido junto com a saída do daemon de impressão**: o script de sidecar não existe mais (o daemon saiu deste repositório, reescrita à parte) e o `externalBin` saiu dos `tauri.conf.json` (app v1 e `standalone-pdv`)
- Consequência boa: `cargo check` roda sem gerar sidecar nenhum — o `build.rs` do Tauri só aborta se houver `externalBin` apontando para binário inexistente
- O diretório `binaries/` continua gitignored (binários antigos de 11 MB não vão para o repositório)
- Retomar o embutimento do daemon quando o novo daemon for integrado (re-adicionar `externalBin` + passo de build junto)

### Versão JS×Rust

- Precisa bater em major.minor, senão o `tauri build` aborta com "Found version mismatched Tauri packages" (o `cargo check` passa e engana)
- **A CLI agora é a da raiz do repo**: `node_modules/.bin/tauri info` (cwd=`frontend/` para o v1). A binária saiu de `frontend/node_modules`, mas o `npx tauri` ainda resolve de dentro de `frontend/` (o npm sobe até a raiz) — o caminho explícito, quando o `npx` resolver errado, é o da raiz
- **O que tem que bater**: `frontend/package.json` (`@tauri-apps/*` de runtime, mais `@tauri-apps/api`/`plugin-*` usados no código) × os crates — `frontend/src-tauri` (app v1, `Cargo.lock` próprio) e a família `standalone-*` (workspace da raiz, `Cargo.lock` na raiz). Ajustar o lock certo (`cargo update -p tauri --precise <versão>` no diretório do crate) ou fixar o npm na mesma minor

### Update automático

- Crate `tauri-plugin-updater` + `updater:default` na capability
- `bundle.createUpdaterArtifacts: true`, `plugins.updater` no `tauri.conf.json` (pubkey + endpoint `/updates/desktop/{{target}}/{{arch}}/{{current_version}}`)
- Job `build-desktop` no CI que assina e publica o manifesto
- A assinatura tem senha: sem `TAURI_SIGNING_PRIVATE_KEY` ou sem `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` o job falha de propósito
- Ambos são secrets — **nunca no repo**
- `requireSignedVersion: true` amarra a versão à assinatura
- Falha de update não bloqueia o boot, o manifesto é validado em Ed25519 no Rust
- Publicar versão = `version` em `frontend/src-tauri/Cargo.toml` **e** em `frontend/package.json` igual à tag (o `tauri.conf.json` do v1 não declara mais `version` — o Tauri lê do `Cargo.toml`); o `build-app.sh` falha se os dois divergirem e a conferência tag×versão do v1 é manual

### Validação

- `cargo fmt --check` **não é gate** aqui (o crate usa indentação de 2 espaços do template do Tauri)
- O que vale: `cargo check --message-format short`
- Windows é o alvo de build do instalador; Linux/macOS servem para `cargo check`/`tauri dev` (CLI da raiz, cwd=`frontend/`)
- O que depende de Windows (NSIS, serviço, assinatura) **não** foi rodado numa máquina real ainda — não marcar como validado sem abrir o `.exe` num Windows limpo
