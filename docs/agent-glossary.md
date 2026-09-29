# Glossário do Domínio

Termos usados no projeto PDV Restaurante/Pub.

## Termos gerais

| Termo | Descrição |
|---|---|
| **PDV** | Ponto de Venda — sistema de gerenciamento de vendas |
| **Comanda** | Documento que registra os itens consumidos por uma mesa/cliente |
| **Balcão** | Atendimento sem mesa (cliente direto no balcão) |
| **Garçom** | Perfil que atende mesas e lança itens |
| **Cozinha** | Perfil que prepara os itens |
| **Gerente** | Perfil com acesso total |
| **Caixa** | Perfil que gerencia o fluxo de caixa |
| **Entregador** | Perfil que realiza entregas |
| **WABA** | WhatsApp Business Account — conta comercial do WhatsApp |
| **BR Code** | Padrão de QR Code do Pix (EMV + CRC-16) |
| **ESC/POS** | Protocolo de impressão térmica |
| **FSD** | Feature-Sliced Design — arquitetura frontend |
| **Tauri** | Framework para apps desktop com Rust + WebView |
| **PWA** | Progressive Web App — app web instalável |

## Termos técnicos

| Termo | Descrição |
|---|---|
| **Ledger** | Registro contábil — no estoque, a soma dos `quantity_delta` |
| **Outbox** | Padrão de mensageria — tabela de eventos a serem enviados |
| **Idempotência** | Garantia de que uma operação pode ser repetida sem efeito colateral |
| **Lock otimista** | Controle de concorrência por versão (`expectedVersion`) |
| **CorrelationId** | Identificador único para rastrear requisições |
| **Advisory Lock** | Lock do Postgres para coordenação entre processos |
| **Expand/Contract** | Padrão de migrations que permite rollback |
| **Blue/Green Deploy** | Deploy sem downtime com duas instâncias |
| **Healthcheck** | Verificação de saúde antes de liberar tráfego |
| **Sidecar** | Processo auxiliar que acompanha o app principal |

## Termos de domínio (restaurante)

| Termo | Descrição |
|---|---|
| **Mesa** | Unidade de atendimento no salão |
| **Categoria** | Agrupamento de produtos (ex.: Bebidas, Pratos) |
| **Grupo de Produção** | Agrupamento de itens por estação (ex.: Cozinha, Bar) |
| **Variação** | Opções de um produto (ex.: tamanho, ponto da carne) |
| **Item** | Produto lançado na comanda |
| **Pagamento** | Registro de pagamento (forma + valor) |
| **Sangria** | Retirada de dinheiro do caixa |
| **Suprimento** | Entrada de dinheiro no caixa |
| **Fornecedor** | Empresa que fornece produtos |
| **Compra** | Documento de compra multi-item |
| **Custo Médio** | Média ponderada do custo de um produto |
| **Valorização** | Valor total do estoque (custo médio × saldo) |
| **Alerta** | Notificação de eventos importantes (comanda aberta, etc.) |
| **Entrega** | Pedido para delivery |
| **Self-Service** | Pedido feito pelo cliente via página pública |
