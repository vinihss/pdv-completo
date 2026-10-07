# Mapa de telas do frontend

As telas autenticadas são selecionadas pelo papel da sessão em `src/app/router.jsx`. A moldura compartilhada (cabeçalho, menu, alertas e saída) é `AppFrame`; a tela pública de pedido fica fora dela.

| Perfil/rota | Tela principal | Responsabilidade / pontos de entrada |
|---|---|---|
| Sem sessão | `src/pages/login/LoginPage.jsx` | Seleção de usuário, PIN e configuração do servidor |
| Garçom (`waiter`) | `src/pages/pdv/PdvPage.jsx` | Quadro de comandas (`src/widgets/order-board/`) e lançamento de itens (`src/features/orders/`) |
| Gerente (`manager`) | `src/pages/manager/ManagerApp.jsx` | Home inicial (`tabs/home/ManagerHome.jsx`) com indicadores de hoje e atalhos; comandas, caixa, clientes, entregas, catálogo, estoque, compras, relatórios, usuários e configurações em `tabs/` |
| Cozinha (`kitchen`) | `src/pages/kitchen/KitchenDisplay.jsx` | Itens em preparo/prontos, grupos de cozinha e tempos de atendimento |
| Caixa (`cashier`) | `src/pages/cashier/CashierApp.jsx` | Gaveta (`src/widgets/cash-drawer/`) e clientes |
| Entregador (`courier`) | `src/pages/courier/CourierApp.jsx` | Entregas e acompanhamento de localização |
| Cliente (`/pedido`) | `src/pages/customer-menu/CustomerMenuPage.jsx` | Cardápio público, carrinho, checkout e acompanhamento do pedido |

## Casca e navegação

- Router, seleção por papel e `AppFrame`: `src/app/router.jsx`.
- Menu, seções e itens permitidos por papel: `src/app/providers/nav/` e `src/widgets/app-menu/`.
- `ManagerApp` e `CashierApp` mostram a tela escolhida pelo `NavProvider`.
- As quatro entradas web/Tauri (`index.html`, `kds.html`, `garcon.html`, `entregador.html`) compartilham React; metadados/perfil por entrada são definidos em `vite/app-profiles.js`.
- Providers de sessão, configuração, alertas e foco de comanda: `src/app/providers/`.

Para detalhes das regras de camadas, consulte `agent-frontend.md`; para execução de verificações, `agent-testing.md`.
