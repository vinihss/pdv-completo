# Frontend Specification — POS System (Stage 1)

## 1. Escopo

Perfis cobertos nesta etapa: **waiter** (garçom) e **manager** (gerente). O perfil **kitchen** tem uma tela própria, mas de uso operacional simples (sem cadastro, sem navegação complexa).

Fora do escopo: telas de pagamento, telas de relatório/estoque, qualquer fluxo fiscal.

## 2. Plataforma

**PWA (Progressive Web App)**, não app nativo por plataforma. Justificativa: o servidor roda na rede local (ou cloud, no modo cloud), então não há vantagem em nativo; um PWA instalável roda igual em tablet Android, iPad ou navegador de PC, com um único código-fonte, e ainda permite cache local básico para tolerar instabilidade momentânea de rede interna.

**Stack sugerida**: React, consumindo a API REST + WebSocket definidos em `01-backend-spec.md`.

## 3. Autenticação e seleção de usuário

Tela inicial não é login tradicional (usuário/senha) — é uma **seleção de avatar/nome**, já que o tablet é compartilhado entre a equipe:

```
[Tela: Selecionar Usuário]
  → grid de nomes/avatares (todo user ativo)
  → toque no nome → teclado numérico → PIN (4-6 dígitos)
  → sucesso: token salvo, navega pra tela inicial do role
  → erro: mensagem de PIN inválido, sem detalhar motivo (bloqueio, etc — evita dar pista pra tentativa de força bruta)
```

Troca de usuário: qualquer tela tem acesso rápido a "trocar usuário", que descarta o token local e volta pra essa tela — sem precisar de "logout" formal.

**Grid de usuários é filtrado por `store_settings.kitchen_enabled`**: se a cozinha estiver desativada (seção 5), usuários com role `kitchen` não aparecem na seleção — não faz sentido oferecer login pra uma estação que o estabelecimento não usa. Isso é um filtro de exibição, não uma restrição de conta: o usuário `kitchen` continua existindo, só não aparece até o gerente reativar o recurso.

## 4. Fluxo do Garçom

### 4.1 Tela inicial — Lista/mapa de comandas abertas

Grid visual misturando os dois modelos de identificação (mesa e cliente/pub):

- Card com **número de mesa**, se `table_id` preenchido — cor indica status (`free`/`occupied`/`closing`)
- Card com **nome do cliente ou `tab_label`**, se aberto sem mesa
- Botão fixo e visível: **"Nova comanda"**

### 4.2 Abrir nova comanda

Toggle no topo do formulário: **Mesa** / **Cliente** — **visível apenas se `store_settings.uses_tables = true`**. Quando desativado (estabelecimento tipo pub, sem organização por mesa), o toggle não aparece e o formulário vai direto para o modo Cliente.

```
Modo Mesa (só quando uses_tables = true):
  → grid de mesas livres → toque seleciona → abre order com table_id

Modo Cliente:
  → campo de busca (nome ou telefone)
    → encontrado → seleciona → abre order com customer_id
    → não encontrado → "Cadastrar novo cliente" (nome + telefone opcional) → abre order com novo customer_id
  → alternativa rápida sem busca: campo livre de "rótulo" (ex: "Comanda 12") → abre order com tab_label,
    sem tocar em customer
```

Prioridade de UX (velocidade máxima): o modo Mesa deve abrir a comanda em no máximo 2 toques (selecionar mesa → confirmar). O modo Cliente com rótulo livre deve ser igualmente rápido (digitar → confirmar), reservando a busca/cadastro de cliente para quando o garçom realmente quiser vincular a pessoa.

O mesmo parâmetro `uses_tables` também remove o chip de filtro "Mesa" na tela de lista (seção 4.1) quando desativado, já que não faz sentido filtrar por algo que o estabelecimento não usa.

### 4.3 Tela de comanda aberta

- Cabeçalho: identificação (mesa ou cliente/rótulo) + total corrente (via `order_running_total`)
- Lista de itens lançados, cada um exibindo:
  - Nome do produto + variação selecionada (se houver)
  - Quantidade
  - **Badge de status**: `ordered` (neutro/cinza), `ready` (destaque, ex: verde), `delivered` (apagado/riscado)
  - **Ação de remover** (ícone de lixeira): visível apenas em itens com status diferente de `delivered`. Ao tocar, exibe modal de confirmação ("Remover 2× X-Burger? Essa ação não pode ser desfeita.") antes de excluir — remoção nunca é imediata, sempre passa por confirmação explícita. Chama `DELETE /orders/:id/items/:itemId` e gera entrada no log de auditoria.
- Botão grande e fixo: **"Adicionar item"**
- Botão: **"Fechar conta"** — desabilitado enquanto houver item que ainda não está `delivered` (ver seção 4.5 para o comportamento completo)

**Comportamento depende de `store_settings.kitchen_enabled`** (toggle do gerente, seção 5):

- **Com cozinha (`kitchen_enabled = true`)**: item nasce `ordered`, a cozinha marca `ready` (tela própria, seção 6), e só então o item vira tocável pelo garçom pra marcar `delivered`. Itens `ordered` não são tocáveis — o garçom não pode "entregar" algo que a cozinha ainda não preparou.
- **Sem cozinha (`kitchen_enabled = false`)**: não existe estação separada — item nasce `ordered` e já é tocável direto pelo garçom pra marcar `delivered`, pulando `ready` por completo. Um aviso substitui o de "toque no item pronto": *"Sem cozinha cadastrada — toque no item para marcar como entregue"*.

Quando um item muda para `ready` via evento WebSocket (só ocorre com `kitchen_enabled = true`), o badge atualiza sozinho, sem o garçom precisar recarregar a tela. Se o garçom estiver em outra tela no momento, uma notificação ativa (toast/som) avisa (ver seção 6).

Ao ver fisicamente o prato/bebida pronto, o garçom toca no item e marca `delivered` manualmente — a partir desse momento a ação de remover deixa de estar disponível para aquele item (item já entregue não deve mais ser removido pelo garçom; qualquer estorno depois disso é tratado fora do sistema nesta etapa).

### 4.4 Adicionar item

Diferente da primeira versão desta spec, adicionar item **não commita direto na comanda a cada toque** — isso testou mal: o garçom perdia a noção do que já tinha sido lançado. O fluxo agora é carrinho → revisão → confirmação explícita, com mensagem de sucesso ao final:

```
[Categorias em abas ou seção fixa no topo]
  → toque na categoria → grid de produtos daquela categoria
  → toque no produto:
      → sem variação: adiciona ao carrinho local desta visita (1 toque)
      → com variação: modal rápido de seleção de opções → confirmar → adiciona ao carrinho (2-3 toques)
  → cada toque dá feedback visual imediato e óbvio no próprio card do produto:
      - o card pisca em verde com um ícone de check por ~450ms
      - um badge numérico fixo no canto do card mostra a quantidade já adicionada daquele produto nesta visita
  → assim que o carrinho tem 1+ item, uma barra fixa aparece no rodapé:
      "N itens · R$ total — Revisar e confirmar →"
  → toque na barra abre uma folha de revisão (bottom sheet) listando cada linha do carrinho:
      - nome do produto + variação
      - stepper de quantidade (–/+)
      - botão de remover a linha
      - total geral
  → dois botões no rodapé da revisão:
      - "Continuar adicionando" → fecha a folha, garçom volta pro grid sem perder o carrinho
      - "Confirmar adição" → commita todas as linhas de uma vez (POST /orders/:id/items em lote,
        idempotente via correlationId por linha)
  → ao confirmar: tela de sucesso breve (ícone de check + "N itens lançados em {comanda}")
    por ~1s, e então navega direto para a tela de lista de comandas (não para a comanda aberta)
```

Essa navegação direta para a lista ao final é intencional: o garçom normalmente vai atender outra mesa em seguida, não continuar mexendo naquela mesma comanda. Se precisar voltar a ela, é 1 toque a partir da lista.

Busca por texto (nome do produto) continua disponível no topo, sem navegar por categoria, para quando o garçom já sabe o que vai lançar.

### 4.4.1 Log de auditoria

Cada linha confirmada gera um registro individual no log de auditoria (`item_added`), assim como remoção de item (`item_removed`), item marcado como entregue (`item_delivered`), abertura de comanda (`order_opened`) e fechamento de comanda (`order_closed`, incluindo a forma de pagamento). O garçom acessa esse histórico via um ícone na tela de lista de comandas (seção 4.1) — útil para conferência de turno ou investigação de divergência. Ver `01-backend-spec.md`, seção 13.

### 4.5 Fechar conta

**Regra**: a comanda só pode ser fechada quando todo item estiver `delivered` (ou `cancelled`, se essa transição existir). Essa regra já é imposta pelo backend (`01-backend-spec.md`, seção 9 — `closeOrder` roda em transação e lança `PendingItemsError` se houver item pendente), então a UI deve refletir isso preventivamente, não apenas tratar o erro depois que ele acontece:

- O botão **"Fechar conta"** fica desabilitado (visualmente inativo, não escondido) enquanto houver qualquer item que não seja `delivered`.
- Abaixo do botão, um aviso curto explica o motivo e a quantidade: *"1 item ainda não foi entregue — confirme a entrega antes de fechar"* (plural quando houver mais de um).
- Essa mesma regra vale na função de caixa do gerente (seção 5): a lista de comandas abertas mostra a contagem de itens pendentes no lugar do botão "Fechar" quando aplicável, em vez de deixar o gerente tentar fechar e receber um erro.

Resumo com todos os itens e total. Ao confirmar (com a comanda liberada para fechamento), o garçom monta o pagamento com as formas habilitadas em `store_settings.enabled_payment_methods` (o gerente controla quais aparecem — ver seção 5).

**Pagamento fracionado (múltiplas formas)**: a comanda pode ser paga com várias formas de uma vez (ex.: dinheiro + Pix). A modal de pagamento permite:

- **Adicionar itens de pagamento** — um por forma escolhida (Dinheiro, Cartão, Pix, Outro), cada um com seu **valor**.
- **Dinheiro com troco**: além do valor, pede "Recebido (R$)" e calcula o **troco ao vivo** (`recebido − valor`). Se o recebido for menor que o valor, mostra "Faltam R$ X" e bloqueia o registro.
- **Dividir igualmente entre N pessoas**: seletor de N (1–20) + forma → distribui o total em N pedaços iguais de uma vez (o último pedaço absorve o resto para a soma fechar exata).
- **Barra de saldo**: mostra quanto ainda falta / quanto excede (`| Soma − Total | < 0.005`). O registro só habilita quando a soma **confere com o total** da comanda.
- **Pix por pedaço**: cada pedaço Pix gera seu próprio QR (BR Code) com o valor **daquele pedaço**, não do total. Depois de registrar, o client exibe um QR por vez e confirma um a um (o pedaço nasce `confirmed=false` e só vira `confirmed=true` com "Confirmar recebimento").

Confirmação por forma (não por etapa global):
- **Dinheiro/Cartão/Outro**: confirmados no momento do registro (o dinheiro ainda exige `received ≥ amount`).
- **Pix**: nasce pendente e é confirmado após escaneado o QR e conferido o extrato — o fechamento da comanda e o da confirmação são a mesma etapa, sem tela extra.

Nenhuma forma de pagamento nesta etapa envolve integração com adquirente ou confirmação automática — mesmo o Pix depende de conferência manual antes de fechar. O fechamento gera entrada no log de auditoria com o detalhe dos pedaços. A tela de detalhe da comanda mostra o quebra-cabeça do pagamento (cada forma, valor e troco) e permite reabrir a modal para ajustar enquanto a conta não fechou.

## 5. Fluxo do Gerente

```
Gerente
├── Comandas — a MESMA interface do garçom (seção 4), não uma versão reduzida
│   ├── Abrir comanda, lançar item (carrinho → revisão → confirmação), remover item,
│   │   marcar entregue, fechar conta — tudo com as mesmas regras de negócio
│   └── Diferença prática: o gerente vê e pode agir sobre comandas de qualquer garçom,
│       não só as que ele mesmo abriu — cobre o caso de o garçom estar ocupado e o
│       cliente querer pagar e sair, ou de precisar corrigir algo lançado por outra pessoa
├── Relatórios
│   ├── Filtros: período (de/até), cliente/mesa/comanda (busca por texto), produto (lista)
│   ├── Resumo: total vendido, número de comandas fechadas, ticket médio
│   ├── Detalhamento por forma de pagamento
│   └── Tabela de comandas fechadas que batem com o filtro (cliente, data/hora de
│       fechamento, forma de pagamento, total)
├── Produtos
│   ├── Lista (busca, filtro por categoria, toggle ativo/inativo)
│   └── Formulário (nome, categoria, preço, variações opcionais, ativo/inativo)
├── Categorias
│   ├── Criar (nome)
│   ├── Renomear (edição inline, clique no nome)
│   ├── Reordenar (setas ↑/↓, define display_order)
│   └── Excluir (com confirmação; se houver produtos vinculados, aviso explícito de que ficam sem
│       categoria até reatribuição manual — exclusão não é bloqueada, só avisada)
├── Usuários
│   ├── Lista (nome, role, ativo/inativo)
│   └── Formulário (nome, role, definir/resetar PIN)
└── Configurações
    ├── Usar mesas (toggle) — liga/desliga a opção de mesa na abertura de comanda do garçom
    ├── Usar tela da cozinha (toggle) — liga/desliga a etapa "pronto"; desativado, o garçom marca
    │   o item como entregue direto, sem esperar uma estação de cozinha que não existe naquele
    │   estabelecimento (ver seção 6)
    ├── Formas de pagamento habilitadas (checkboxes: Dinheiro, Cartão, Pix, Outro)
    ├── Dados para cobrança Pix (nome do estabelecimento, cidade, tipo e valor da chave)
    └── Limiares de tempo da tela da cozinha (3 campos numéricos, em minutos, só visível se
        "Usar tela da cozinha" estiver ativo): alerta em preparo, urgente em preparo,
        urgente aguardando retirada
```

**Decisão de design — "Comandas" não é uma tela separada pro gerente**: nas primeiras versões desta spec, o gerente tinha uma tela reduzida, só de função de caixa (ver/fechar). Isso mudou — o gerente precisa fazer qualquer coisa que o garçom faz (corrigir lançamento, adicionar item esquecido, remover item errado), não só fechar conta. A implementação de referência (`pos-app-integrated.jsx`) resolve isso reaproveitando literalmente os mesmos componentes de tela do garçom dentro da navegação do gerente, operando sobre o mesmo conjunto de comandas — evita duas implementações divergentes do mesmo fluxo.

**Formulário de produto**: variações são explicitamente opcionais — a UI não deve forçar preenchimento. Construtor dinâmico tipo "adicionar variação" (nome da variação) → "adicionar opção" (repetível), mapeando direto para o campo `variations` (JSONB) do schema. Produto sem nenhuma variação é o caso normal, não uma exceção (ex: uma cerveja).

**Formulário de categoria**: nome editável inline + ordem de exibição, já que isso define a ordem das abas na tela de seleção de produto do garçom (seção 4.4). Exclusão sempre passa por confirmação, com aviso diferenciado quando existem produtos vinculados àquela categoria.

**Formulário de usuário**: nome, role (waiter/kitchen/manager), e definição de PIN — sem exibir PIN existente (só permite resetar).

**Configurações**: os toggles e formas de pagamento afetam imediatamente a experiência do garçom — não exigem deploy nem reinício do app, só releitura de `store_settings` no próximo carregamento da tela relevante. O toggle de cozinha também afeta a tela de seleção de usuário (login): sem cozinha habilitada, não faz sentido oferecer um usuário do tipo `kitchen` na lista — ver seção 3.

## 6. Tela da Cozinha

**Esta tela inteira é condicional a `store_settings.kitchen_enabled = true`** (toggle do gerente, seção 5). Em estabelecimentos sem estação de preparo separada — um pub pequeno onde quem serve também prepara, por exemplo — o recurso fica desligado: o usuário `kitchen` some da tela de login (seção 3), e o fluxo de item na comanda do garçom pula `ready` inteiramente (seção 4.3). O que segue descreve o comportamento quando o recurso está ativo.

Dispositivo fixo (tablet ou TV na passagem), tipicamente sem seleção de usuário individual — login vinculado ao role `kitchen` (estação única, não pessoa). Layout de duas zonas verticais, pensado para ser lido de longe e operado com toques grandes, sem sub-menus:

```
┌─────────────────────────────┐
│  EM PREPARO                 │  ← ~70% da altura da tela
│  (status: ordered)          │
│  ordenado por created_at,   │
│  mais antigo no topo        │
│                              │
│  [Item] [Item] [Item] ...   │  ← grid, cartão inteiro é a área de toque
│  toque → marca "ready"      │
├─────────────────────────────┤
│  PRONTOS                    │  ← ~30% da altura, faixa com rolagem horizontal
│  (status: ready)            │
│  aguardando retirada        │
│                              │
│  [Item] [Item] ...          │
│  destaque visual (borda +   │
│  pulso) se ultrapassar      │
│  tempo limite sem retirada  │
└─────────────────────────────┘
```

**Cartão de item (zona Em preparo)**: quantidade em destaque (ex: "2×"), nome do produto, variação/observação se houver, referência à mesa/comanda (secundário, texto menor), e um cronômetro (`mm:ss` desde `created_at`). O cronômetro muda de cor para sinalizar prioridade sem exigir reordenação manual pelo cozinheiro:

| Tempo em preparo | Cor |
|---|---|
| até `kitchen_prep_warn_min` | neutra (cinza) |
| entre `kitchen_prep_warn_min` e `kitchen_prep_urgent_min` | âmbar |
| acima de `kitchen_prep_urgent_min` | vermelha, com pulso na borda do cartão |

**Decisão de produto (resolvida)**: esses limiares são configuráveis pelo gerente em Configurações (seção 5), não constantes fixas no código — cada estabelecimento tem seu próprio ritmo de cozinha. `store_settings` traz `kitchen_prep_warn_min` (padrão 3), `kitchen_prep_urgent_min` (padrão 6) e `kitchen_pickup_urgent_min` (padrão 5, ver abaixo). A tela da cozinha lê esses valores ao carregar — não precisa de reload do app inteiro quando o gerente muda, só da tela da cozinha buscar `store_settings` de novo (mesmo padrão das seções 4.2/5 pros outros toggles).

Tocar em qualquer parte do cartão marca o item como `ready` (`PATCH /orders/:id/items/:itemId`) e ele se move imediatamente para a faixa "Prontos", com uma pequena animação de entrada.

**Faixa "Prontos"**: cada cartão tem seu próprio cronômetro, agora contando a partir de `readyAt`. Se ultrapassar `kitchen_pickup_urgent_min`, o cartão recebe o mesmo tratamento visual de urgência (borda vermelha pulsante) — sinal de que o prato está esfriando na passagem e o garçom precisa ser avisado/lembrado fora do sistema, se necessário. Um item some dessa faixa **apenas quando o garçom marca `delivered`** no app dele (evento-orientado, nunca por tempo) — reaproveita o mesmo fluxo de status já existente, sem lógica adicional no backend.

### Notificação ativa para o garçom

Quando a cozinha marca um item como `ready`, o evento `order.item.status_changed` é publicado tanto no room `table:{tableId}` (atualiza o badge na comanda) quanto no room `waiter:{waiterId}` (dispara toast/som mesmo se o garçom estiver em outra tela do app) — ver `01-backend-spec.md`, seção 8.

### Novos pedidos chegando

Ao lançar itens na comanda (fluxo do garçom, seção 4.4), cada linha confirmada dispara `order.item.created`, que a tela da cozinha assina em tempo real — o item aparece direto na zona "Em preparo", sem precisar de recarregamento manual. Um toast discreto no topo da tela pode reforçar a chegada de um novo pedido, especialmente útil quando a cozinha está de costas para a tela num momento de rush.

### Protótipo

`kitchen-display-prototype.jsx` implementa esse comportamento de forma navegável: toque nos cartões da zona "Em preparo" para marcar como pronto, cronômetros reais por item, destaque de urgência por cor/pulso, chegada simulada de novos pedidos a cada ~14s, e remoção simulada de itens da faixa "Prontos" a cada ~11s (representando o garçom confirmando a entrega no app dele).

## 7. Pontos em aberto para decisão de produto

Ambos os pontos que estavam aqui foram resolvidos:

- **Telefone no cadastro rápido de cliente**: confirmado opcional (já era o comportamento descrito na seção 4.2; `customer.phone` é nullable no schema).
- **Limites de tempo da cozinha**: confirmado configurável pelo gerente, não fixo — ver seção 6 (valores em `store_settings`, com padrão 3/6/5 minutos) e seção 5 (onde o gerente edita).

Se novos pontos de decisão de produto surgirem, entram aqui.

## 8. Resumo de telas

| Tela | Perfil | Fonte de dados |
|---|---|---|
| Selecionar usuário / PIN | Todos | `POST /auth/login` — usuário `kitchen` oculto se `store_settings.kitchen_enabled = false` |
| Lista/mapa de comandas | Waiter, Manager (mesma tela, acesso total) | `GET /tables`, `GET /orders?status=open`, WS `table.status_changed` |
| Abrir comanda (mesa/cliente) | Waiter, Manager | `POST /orders` — Mesa oculta se `store_settings.uses_tables = false` |
| Comanda aberta | Waiter, Manager | `GET /orders/:id`, WS `order.item.status_changed`, `DELETE /orders/:id/items/:itemId` |
| Adicionar item (carrinho → revisão → confirmação) | Waiter, Manager | `POST /orders/:id/items` (lote, ao confirmar) |
| Fechar conta (com confirmação obrigatória) | Waiter, Manager | `PATCH /orders/:id/payment`, `PATCH /orders/:id/close` |
| Relatórios (vendas, filtros por período/cliente/produto) | Manager | `GET /reports/sales` |
| Cozinha (em preparo/prontos) — só existe se `kitchen_enabled = true` | Kitchen | WS `order.item.created`, `order.item.status_changed`; ação via `PATCH /orders/:id/items/:itemId` |
| Cadastro de produtos | Manager | `GET/POST/PATCH /products` |
| Cadastro de categorias | Manager | `GET/POST/PATCH/DELETE /categories` |
| Cadastro de usuários | Manager | CRUD de `user` |
| Configurações (mesas, cozinha, pagamentos, Pix) | Manager | `GET/PUT /store-settings` |
| Log de atividades | Waiter, Manager | `GET /audit-log?order_id=` |
