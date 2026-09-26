# Arquitetura do frontend (PDV)

Estrutura feature-first, pensada para facilitar extensão e personalização —
inclusive por agentes de IA. Regra de ouro: **cada domínio de negócio vive em
uma pasta `features/<domínio>/` com seus próprios componentes, hooks e utils.**

## Visão da estrutura

```
src/
├── app/              # Roteamento, AppFrame (chrome da loja), root por papel
├── features/         # ★ um diretório por domínio de negócio
│   ├── orders/       # comandas (garçom + gerente)
│   ├── catalog/      # categorias, grupos de produção, produtos
│   ├── users/        # equipe
│   ├── deliveries/   # entregas (painel do gerente)
│   ├── courier/      # app do entregador
│   ├── kitchen/      # tela da cozinha
│   ├── reports/      # relatório de vendas
│   ├── audit/        # auditoria
│   ├── settings/     # configurações da loja
│   ├── ifood/        # integração iFood
│   ├── customer-menu/# página pública de pedido (/pedido)
│   └── auth/         # login, AuthContext/useAuth
├── shared/
│   ├── api/          # client HTTP por domínio (http.js + domínios)
│   ├── components/   # primitivas reutilizáveis (Toast, Form, ConfirmModal, ...)
│   ├── hooks/        # hooks genéricos (useRealtime, ...)
│   └── lib/          # utils puras (format, money, theme, pix, uuid)
├── config/           # (CSS/design tokens)
├── App.jsx
└── main.jsx
```

## Convenções (o que agentes devem memorizar)

- **1 feature = 1 pasta.** Componentes, hooks e utils de um domínio ficam juntos.
- **Primitivas vão para `shared/components`**; hooks genéricos em
  `shared/hooks`; utils puras em `shared/lib`.
- **Imports sempre via alias `@`** → resolve para `src/` (configurado em
  `vite.config.js` e `jsconfig.json`). Ex.: `import { openOrder } from "@/entities/order"`.
- **Barrel `index.js` por pasta**: `features/orders/index.js` re-exporta os
  componentes/hooks do domínio, permitindo `import { OrdersRoot } from "@/features/orders"`.
- **Telas por papel viram orquestradores finos** que montam `features/*`
  (ex.: `features/manager/ManagerApp.jsx` só gerencia abas).
- **Server-authoritative**: mutation `await` + reload via REST; WebSocket
  (`useRealtime`) só para refresh direcionado. Sem otimismo.

## Como adicionar um novo domínio

1. Crie `src/features/novo-domino/`.
2. Coloque os componentes, hooks (`use*.js`) e utils (`*.utils.js`) ali.
3. Crie `index.js` como barrel.
4. Registre no roteamento (`src/app/router.jsx`) se for uma nova tela/papel.

## Client HTTP por domínio

`shared/api/http.js` é o **único** módulo de infraestrutura de rede (token,
unauthorized, `request`/`upload`). A API de cada domínio de negócio mora na
respectiva entity: `entities/<dominio>/api/`, importada pela API pública da
entity (`import { listStock } from "@/entities/stock"`). Nunca crie um arquivo
de API em `shared/`. Estratégia completa em `docs/09-frontend-fsd.md`.