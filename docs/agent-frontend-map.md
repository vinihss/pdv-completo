# Mapa de Telas do Frontend

Mapa de telas, componentes e entities para agentes encontrarem código rapidamente.

## Telas (Pages)

| Tela | Papel | Arquivo | Components/Widgets | Entities |
|---|---|---|---|---|
| Login | todos | `pages/login/LoginPage.jsx` | `LoginPage`, `LoginForm` | `session`, `user` |
| PDV (Comandas) | waiter | `pages/pdv/PdvPage.jsx` | `OrderBoard`, `OrderDetailScreen`, `AddItemScreen` | `order`, `product`, `category`, `table`, `cart` |
| Gerente | manager | `pages/manager/ManagerApp.jsx` | `OrderBoard` + abas (ver abaixo) | `order`, `product`, `category`, `table`, `cart`, `stock`, `cash`, `customer`, `user`, `reports`, `audit`, `delivery`, `ifood`, `whatsapp`, `printer` |
| Cozinha | kitchen | `pages/kitchen/KitchenDisplay.jsx` | `KitchenDisplay` | `order`, `kitchen-group` |
| Caixa | cashier | `pages/cashier/CashierApp.jsx` | `CashDrawer`, `CustomersTab` | `cash`, `customer` |
| Entregador | courier | `pages/courier/CourierApp.jsx` | `CourierApp` | `delivery` |
| Menu Público | público | `pages/customer-menu/CustomerMenuPage.jsx` | `MenuScreen`, `ProductCard`, `ProductTile`, `CartLine` | `product`, `category`, `cart`, `order` |

## Abas do Gerente

| Aba | Arquivo | Entities |
|---|---|---|
| Comandas | `pages/manager/ManagerApp.jsx` (default) | `order`, `product`, `category`, `table` |
| Configurações | `pages/manager/tabs/settings/SettingsTab.jsx` | `store`, `printer`, `whatsapp` (painel embutido) |
| Dinheiro | `pages/manager/tabs/cash/CashTab.jsx` | `cash` |
| Clientes | `pages/manager/tabs/customers/CustomersTab.jsx` | `customer` |
| Entregar | `pages/manager/tabs/deliveries/DeliveriesTab.jsx` | `delivery` |
| Relatórios | `pages/manager/tabs/reports/ReportsTab.jsx` | `reports` |
| Estoque | `pages/manager/tabs/inventory/StockTab.jsx` | `stock` |
| Compras | `pages/manager/tabs/purchase/PurchaseTab.jsx` | `purchase` |
| Catálogo | `pages/manager/tabs/catalog/CatalogTab.jsx` | `product`, `category` |
| Auditoria | `pages/manager/tabs/audit/AuditTab.jsx` | `audit` |
| Equipe | `pages/manager/tabs/users/UsersTab.jsx` | `user` |
| WhatsApp | `pages/manager/tabs/whatsapp/WhatsAppTab.jsx` — não é aba de menu: o `SettingsTab` o renderiza embutido, só com `store_settings.whatsapp_integration_enabled` ligado | `whatsapp` |
| iFood | `pages/manager/tabs/ifood/IfoodTab.jsx` — some do menu quando `store_settings.ifood_integration_enabled` está desligado | `ifood` |

## Widgets

| Widget | Arquivo | Usado por |
|---|---|---|
| OrderBoard | `widgets/order-board/` | PDV, Gerente |
| CashDrawer | `widgets/cash-drawer/` | Caixa, Gerente |
| AppMenu | `widgets/app-menu/` | Todas as telas logadas |
| AlertBell | `widgets/alert-bell/` | Todas as telas logadas |

## Features

| Feature | Arquivo | Descrição |
|---|---|---|
| Orders | `features/orders/` | Abrir comanda, lançar item, revisar, pagar, QR Pix |

## Entities (Domínio)

| Entity | API | Model | UI |
|---|---|---|---|
| order | `entities/order/api/` | `entities/order/model/` | `entities/order/ui/` |
| product | `entities/product/api/` | `entities/product/model/` | `entities/product/ui/` |
| category | `entities/category/api/` | — | — |
| cart | `entities/cart/api/` | `entities/cart/model/` | — |
| stock | `entities/stock/api/` | `entities/stock/model/` | — |
| cash | `entities/cash/api/` | — | — |
| customer | `entities/customer/api/` | — | — |
| user | `entities/user/api/` | — | — |
| delivery | `entities/delivery/api/` | `entities/delivery/model/` | `entities/delivery/ui/` |
| reports | `entities/reports/api/` | `entities/reports/model/` | — |
| audit | `entities/audit/api/` | `entities/audit/model/` | — |
| ifood | `entities/ifood/api/` | — | — |
| whatsapp | `entities/whatsapp/api/` | — | — |
| printer | `entities/printer/api/` | — | — |
| store | `entities/store/api/` | — | — |
| table | `entities/table/api/` | — | — |
| session | `entities/session/api/` | — | — |
| payment | `entities/payment/lib/` | — | — |
| alert | `entities/alert/api/` | `entities/alert/model/` | — |
| kitchen-group | `entities/kitchen-group/api/` | — | — |
| updater | `entities/updater/api/` | — | — |

## Shared (Genérico)

| Componente | Arquivo |
|---|---|
| HTTP Client | `shared/api/http.js` |
| Modal | `shared/components/Modal.jsx` |
| Drawer | `shared/components/Drawer.jsx` |
| ConfirmModal | `shared/components/ConfirmModal.jsx` |
| ScreenHeader | `shared/components/ScreenHeader.jsx` |
| Toast | `shared/components/Toast.jsx` |
| Form/Section | `shared/components/Form.jsx` |
| AccordionMenu | `shared/components/AccordionMenu.jsx` |
| UserAvatar | `shared/components/UserAvatar.jsx` |
| VariationModal | `shared/components/VariationModal.jsx` |
| useRealtime | `shared/hooks/useRealtime.js` |
| useEscapeLayer | `shared/hooks/useEscapeLayer.js` |
| useBodyScrollLock | `shared/hooks/useBodyScrollLock.js` |
| useFocusTrap | `shared/hooks/useFocusTrap.js` |
| platform | `shared/lib/platform.js` |
| appConfig | `shared/lib/appConfig.js` |
| uuid | `shared/lib/uuid.js` |
| audio | `shared/lib/audio.js` |
| pix | `shared/lib/pix.js` |
| format | `shared/lib/format.js` |
| money | `shared/lib/money.js` |
| theme | `shared/lib/theme.js` |

## Providers (App)

| Provider | Arquivo |
|---|---|
| AuthProvider | `app/providers/auth/` |
| NavProvider | `app/providers/nav/` |
| AlertsProvider | `app/providers/alerts/` |
| AppConfigProvider | `app/providers/app-config/` |
| OrderFocusProvider | `app/providers/order-focus/` |

## Rotas (Router)

| Path | Tela |
|---|---|
| `/login` | LoginPage |
| `/pdv` | PdvPage (waiter) |
| `/manager` | ManagerApp (manager) |
| `/kitchen` | KitchenDisplay (kitchen) |
| `/cashier` | CashierApp (cashier) |
| `/courier` | CourierApp (courier) |
| `/pedido` | CustomerMenuPage (público) |
