# Mapa de telas do frontend

As telas autenticadas são selecionadas pelo papel da sessão em `src/app/router.tsx`. A moldura compartilhada (cabeçalho, menu, alertas e saída) é `AppFrame`; a tela pública de pedido fica fora dela.

| Perfil/rota | Tela principal | Responsabilidade / pontos de entrada |
|---|---|---|
| Sem sessão | `src/pages/login/LoginPage.tsx` | Login novo por e-mail/senha (docs/26): credenciais → troca obrigatória de senha → seleção de empresa; "Esqueci minha senha" abre a mesma tela na etapa de recuperação e o link do e-mail vai para `/reset-password` (`ResetPasswordPage.tsx`). O login antigo por PIN continua em `/login/pin` (`LoginPagePin.tsx`, fallback) |
| Garçom (`waiter`) | `src/pages/pdv/PdvPage.tsx` | Quadro de comandas (`src/widgets/order-board/`) e lançamento de itens (`src/features/orders/`) |
| Gerente (`manager`) | `src/pages/manager/ManagerApp.tsx` | Home inicial (`tabs/home/ManagerHome.tsx`) com indicadores de hoje e atalhos; comandas, caixa, clientes, entregas, catálogo, estoque, compras, relatórios, usuários e configurações em `tabs/` |
| Cozinha (`kitchen`) | `src/pages/kitchen/KitchenDisplay.tsx` | Itens em preparo/prontos, grupos de cozinha e tempos de atendimento |
| Caixa (`cashier`) | `src/pages/cashier/CashierApp.tsx` | Gaveta (`src/widgets/cash-drawer/`) e clientes |
| Entregador (`courier`) | `src/pages/courier/CourierApp.tsx` | Entregas e acompanhamento de localização |
| Cliente (`/pedido`) | `src/pages/customer-menu/CustomerMenuPage.tsx` | Cardápio público, carrinho, checkout e acompanhamento do pedido |

## Casca e navegação

- Router, seleção por papel e `AppFrame`: `src/app/router.tsx`.
- Menu, seções e itens permitidos por papel: `src/app/providers/nav/` e `src/widgets/app-menu/`.
- `ManagerApp` e `CashierApp` mostram a tela escolhida pelo `NavProvider`.
- As entradas web/Tauri (`index.html`, `kds.html`) compartilham React; metadados/perfil por entrada são definidos em `vite/app-profiles.js`. (Os perfis Garçom/Entregador migraram para `pdv-mobile-apps`.)
- Providers de sessão, configuração, alertas e foco de comanda: `src/app/providers/`. O `AuthProvider` (`providers/auth/`) conduz o fluxo de identidade em dois estágios — estágio de **conta** (e-mail/senha, em memória) e **sessão de tenant** (persistida em `localStorage`/`sessionStorage`) — e é ele que expõe `loginNovo`, a seleção de empresa e o refresh de token.

Para detalhes das regras de camadas, consulte `agent-frontend.md`; para execução de verificações, `agent-testing.md`.
