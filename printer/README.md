# Daemon de impressão PDV — integração com React/Tauri

Este projeto fornece somente o **daemon local de impressão em Go** e os templates ESC/POS. O frontend pode ser uma aplicação React/Tauri própria, independente deste repositório.

O fluxo de integração é:

```text
Sua aplicação React/Tauri
        ↓ HTTP local
http://127.0.0.1:8080
        ↓
Daemon Go
  ├── fila SQLite local
  ├── cache dos trabalhos
  ├── templates JSON
  ├── renderização ESC/POS
  └── envio TCP para a Elgin MP-4200
```

O frontend **não precisa conhecer ESC/POS**, o endereço TCP da impressora ou a estrutura da fila. Ele apenas envia os dados estruturados do pedido ao daemon.

## O que usar deste projeto

```text
daemon/main.go                    serviço local e API HTTP
 daemon/config.example.json        configuração da estação
 daemon/templates/*.json           layouts ESC/POS editáveis
 scripts/install-linux.sh           instalação como serviço systemd
 scripts/install-windows.ps1       instalação como serviço Windows
```

A pasta `src/` e a configuração Tauri presentes no pacote são apenas uma tela de demonstração. Elas não são necessárias para integrar o seu frontend React próprio.

## Pré-requisitos do computador da impressora

- Go 1.22 ou superior para compilar o daemon;
- Elgin MP-4200 acessível por Ethernet/TCP na porta 9100;
- ou uma ponte/serviço local que exponha a impressora USB como TCP;
- permissão para instalar um serviço no sistema operacional.

Para uso em produção, prefira conectar a MP-4200 por Ethernet e reservar um IP para ela no roteador.

## 1. Configurar o daemon

Entre na pasta `daemon` e crie uma cópia da configuração:

```bash
cd daemon
cp config.example.json config.json
```

Edite `config.json`:

```json
{
  "listen": "127.0.0.1:8080",
  "data_dir": "./data",
  "templates_dir": "./templates",
  "allowed_origins": [
    "tauri://localhost",
    "http://localhost:1420",
    "http://localhost:3000"
  ],
  "printers": {
    "kitchen": {
      "address": "192.168.1.50:9100",
      "template": "kitchen-default"
    },
    "courier": {
      "address": "192.168.1.50:9100",
      "template": "courier-default"
    },
    "fiscal": {
      "address": "192.168.1.50:9100",
      "template": "fiscal-default"
    }
  }
}
```

### Configurações importantes

| Campo | Descrição |
|---|---|
| `listen` | Endereço da API local. Mantenha `127.0.0.1:8080`. |
| `data_dir` | Diretório do banco SQLite e da fila local. |
| `templates_dir` | Diretório dos templates JSON. |
| `allowed_origins` | Origens do seu frontend que poderão fazer chamadas HTTP. |
| `printers.kitchen` | Impressora/template usados para cozinha. |
| `printers.courier` | Impressora/template usados para motoboy. |
| `printers.fiscal` | Impressora/template usados para fiscal. |

Se seu React for executado em outra porta durante o desenvolvimento, adicione a origem correspondente, por exemplo:

```json
"allowed_origins": [
  "tauri://localhost",
  "http://localhost:5173"
]
```

Não use `"*"` em `allowed_origins`.

## 2. Executar em desenvolvimento

```bash
cd daemon
go run .
```

Teste se o daemon está funcionando:

```bash
curl http://127.0.0.1:8080/health
```

Resposta esperada:

```json
{"status":"ok"}
```

O banco da fila será criado automaticamente em:

```text
daemon/data/print_queue.db
```

## 3. Instalar como serviço

### Linux

Na raiz do projeto:

```bash
sudo ./scripts/install-linux.sh
```

Depois ajuste a configuração instalada:

```bash
sudo nano /etc/pdv-printer/config.json
sudo systemctl restart pdv-printer
sudo systemctl status pdv-printer
```

O daemon será executado como serviço mesmo quando o frontend não estiver aberto.

### Windows

Abra o PowerShell como Administrador e execute:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

Edite a configuração:

```powershell
notepad "$env:ProgramData\PDV Printer\config.json"
Restart-Service PDVPrinterDaemon
```

O script instala o daemon em `C:\Program Files\PDV Printer` e registra o serviço `PDVPrinterDaemon` para iniciar automaticamente.

## 4. Integrar o seu React/Tauri

O frontend deve chamar o endpoint:

```text
POST http://127.0.0.1:8080/api/print
```

Exemplo de função no React:

```javascript
const PRINTER_DAEMON = 'http://127.0.0.1:8080';

export async function enqueuePrint({ orderId, destination, order }) {
  const response = await fetch(`${PRINTER_DAEMON}/api/print`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      job_id: `${orderId}-${destination}`,
      order_id: orderId,
      destination,
      order
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'Falha ao solicitar impressão');
  }

  return result;
}
```

### Imprimir para a cozinha

```javascript
await enqueuePrint({
  orderId: pedido.id,
  destination: 'kitchen',
  order: {
    number: pedido.numero,
    created_at: new Date().toISOString(),
    type: pedido.tipo,
    notes: pedido.observacoes || '',
    items: pedido.itens.map((item) => ({
      name: item.nome,
      quantity: item.quantidade,
      unit_price_cents: Math.round(item.preco * 100),
      notes: item.observacoes || '',
      addons: item.adicionais || []
    })),
    total_cents: Math.round(pedido.total * 100)
  }
});
```

### Imprimir para o motoboy

```javascript
await enqueuePrint({
  orderId: pedido.id,
  destination: 'courier',
  order: {
    number: pedido.numero,
    created_at: new Date().toISOString(),
    type: 'delivery',
    items: pedido.itens.map((item) => ({
      name: item.nome,
      quantity: item.quantidade,
      unit_price_cents: Math.round(item.preco * 100),
      notes: item.observacoes || '',
      addons: item.adicionais || []
    })),
    total_cents: Math.round(pedido.total * 100),
    customer: {
      name: pedido.cliente.nome,
      phone: pedido.cliente.telefone
    },
    delivery: {
      address: pedido.entrega.endereco,
      number: pedido.entrega.numero,
      complement: pedido.entrega.complemento || '',
      neighborhood: pedido.entrega.bairro || '',
      reference: pedido.entrega.referencia || ''
    },
    payment: {
      method: pedido.pagamento.metodo,
      change_cents: Math.round((pedido.pagamento.troco || 0) * 100)
    }
  }
});
```

### Imprimir o fiscal

```javascript
await enqueuePrint({
  orderId: pedido.id,
  destination: 'fiscal',
  order: {
    number: pedido.numero,
    created_at: new Date().toISOString(),
    items: pedido.itens.map((item) => ({
      name: item.nome,
      quantity: item.quantidade,
      unit_price_cents: Math.round(item.preco * 100),
      notes: '',
      addons: []
    })),
    total_cents: Math.round(pedido.total * 100),
    fiscal: {
      company: dadosNfce.empresa,
      cnpj: dadosNfce.cnpj,
      access_key: dadosNfce.chaveAcesso,
      qr_code_url: dadosNfce.urlQrCode
    }
  }
});
```

Os dados fiscais devem ser enviados somente depois que a NFC-e estiver emitida/autorizada pelo seu fluxo fiscal. O daemon apenas renderiza e envia o documento para a impressora.

## Formato mínimo do pedido

```json
{
  "job_id": "pedido-123-kitchen",
  "order_id": "pedido-123",
  "destination": "kitchen",
  "order": {
    "number": "#123",
    "created_at": "2026-09-26T12:00:00-03:00",
    "type": "delivery",
    "notes": "Sem cebola",
    "items": [
      {
        "name": "Hambúrguer",
        "quantity": 2,
        "unit_price_cents": 2590,
        "notes": "Ponto da carne",
        "addons": ["Cheddar"]
      }
    ],
    "total_cents": 5180
  }
}
```

Use sempre valores em centavos inteiros. Por exemplo:

```text
R$ 25,90 → 2590
R$ 5,00  → 500
```

## Resposta do endpoint

Sucesso:

```json
{
  "job_id": "pedido-123-kitchen",
  "status": "sent_to_printer"
}
```

O status `sent_to_printer` significa que o daemon renderizou o documento e enviou os bytes ao socket TCP. A MP-4200 não confirma, por esse fluxo, se o papel saiu fisicamente.

Erro de conexão:

```json
{
  "job_id": "pedido-123-kitchen",
  "status": "failed",
  "error": "conectar à impressora: ..."
}
```

Mesmo com erro, o trabalho permanece na fila SQLite para consulta e nova tentativa.

## Consultar a fila no React

```javascript
export async function getPrintJobs() {
  const response = await fetch(`${PRINTER_DAEMON}/api/jobs`);
  if (!response.ok) throw new Error('Não foi possível consultar a fila');
  return response.json();
}
```

Resposta:

```json
[
  {
    "id": "pedido-123-kitchen",
    "order_id": "pedido-123",
    "destination": "kitchen",
    "status": "sent_to_printer",
    "attempts": 1,
    "last_error": "",
    "created_at": "2026-09-26T15:00:00Z",
    "updated_at": "2026-09-26T15:00:01Z"
  }
]
```

Estados possíveis:

```text
queued
printing
retry_waiting
sent_to_printer
reprint_confirmation
failed
```

## Retry automático quando a impressora volta online

O daemon mantém um worker contínuo. Trabalhos em `queued` ou `retry_waiting` são consultados periodicamente e tentados novamente quando `next_attempt_at` chega.

Configuração:

```json
"retry": {
  "max_attempts": 8,
  "base_delay_seconds": 2,
  "max_delay_seconds": 120,
  "poll_interval_seconds": 2
}
```

O atraso usa backoff exponencial limitado:

```text
tentativa 1 → 2 segundos
tentativa 2 → 4 segundos
tentativa 3 → 8 segundos
tentativa 4 → 16 segundos
...
limite      → 120 segundos
```

Quando a conexão TCP não pode ser aberta, o job fica assim:

```text
retry_waiting
```

Quando o próximo horário chega, o daemon tenta novamente sem depender do frontend estar aberto. Se a MP-4200 voltar a ficar online, o trabalho segue para `sent_to_printer`.

O endpoint `GET /api/jobs` retorna o agendamento:

```json
{
  "id": "pedido-123-kitchen",
  "status": "retry_waiting",
  "attempts": 3,
  "last_error": "conectar à impressora: connection refused",
  "next_attempt_at": "2026-09-26T16:05:00Z"
}
```

### O que é repetido automaticamente

Somente falhas ao **abrir a conexão** com a impressora, como:

- impressora desligada;
- cabo de rede desconectado;
- IP incorreto ou indisponível;
- porta TCP 9100 recusando conexão;
- timeout de conexão.

### O que não é repetido automaticamente

Falhas durante `Write` não são repetidas automaticamente. Uma falha de escrita pode ocorrer depois que parte dos bytes já foi recebida pela impressora e repetir o trabalho pode gerar uma impressão duplicada.

Nessa situação, o job fica em:

```text
reprint_confirmation
```

O React deve mostrar ao operador:

```text
Não foi possível confirmar se o pedido foi impresso.

[Reimprimir]
[Manter pendente]
[Marcar como impresso]
```

O botão **Reimprimir** chama explicitamente `POST /api/jobs/retry`. Esse endpoint zera a contagem automática e cria uma nova tentativa deliberada.

### Limite de tentativas

Ao atingir `max_attempts`, o daemon para o retry automático e mantém o job em `reprint_confirmation`. O operador poderá corrigir a impressora e acionar a reimpressão manualmente.

O retry automático é persistente porque `status`, `attempts`, `last_error` e `next_attempt_at` ficam no SQLite. Portanto, se o daemon for reiniciado enquanto a impressora estiver desligada, ele continua a fila depois que voltar.

## Repetir uma impressão com erro

```javascript
export async function retryPrint(jobId) {
  const response = await fetch(`${PRINTER_DAEMON}/api/jobs/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId })
  });

  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Falha ao repetir impressão');
  return result;
}
```

## Idempotência e `job_id`

O daemon utiliza `UNIQUE(order_id, destination)`. Portanto, não gere um `order_id` diferente a cada renderização ou atualização da tela.

Recomendação:

```javascript
const jobId = `${pedido.id}-kitchen`;
const orderId = pedido.id;
```

Para imprimir novamente de forma intencional, use o endpoint de retry ou crie uma revisão explícita do pedido. Não use `Date.now()` como único identificador para a impressão normal, pois isso pode duplicar pedidos quando o usuário clicar duas vezes.

## Consultar status da impressora com DLE EOT

O daemon possui o endpoint:

```text
GET http://127.0.0.1:8080/api/printers/status
```

Para consultar somente um destino:

```text
GET http://127.0.0.1:8080/api/printers/status?destination=kitchen
```

Quando `status: true` está configurado no perfil, o daemon abre uma conexão TCP com a impressora para cada consulta e envia os comandos ESC/POS:

```text
DLE EOT 1 — status geral/offline
DLE EOT 2 — status offline/tampa
DLE EOT 3 — erros, incluindo guilhotina
DLE EOT 4 — sensores do rolo de papel
```

Exemplo no `config.json`:

```json
{
  "address": "192.168.1.50:9100",
  "template": "kitchen-default",
  "status": true
}
```

Exemplo de chamada no React:

```javascript
export async function getPrinterStatus(destination) {
  const url = new URL(`${PRINTER_DAEMON}/api/printers/status`);
  url.searchParams.set('destination', destination);

  const response = await fetch(url);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'Falha ao consultar a impressora');
  }

  return result;
}
```

Resposta esperada quando a MP-4200 responde:

```json
{
  "destination": "kitchen",
  "address": "192.168.1.50:9100",
  "reachable": true,
  "status_supported": true,
  "ready": true,
  "paper": "ok",
  "cover_open": false,
  "offline": false,
  "error": false,
  "cutter_error": false,
  "raw": {
    "n1": 22,
    "n2": 0,
    "n3": 0,
    "n4": 0
  },
  "checked_at": "2026-09-26T16:00:00Z"
}
```

Possíveis valores de `paper`:

```text
ok
near_end
out
unknown
```

Exemplo de decisão no frontend:

```javascript
const status = await getPrinterStatus('kitchen');

if (!status.reachable) {
  throw new Error('Impressora desligada ou inacessível');
}

if (status.paper === 'out') {
  throw new Error('Impressora sem papel');
}

if (status.cover_open || status.cutter_error || status.error) {
  throw new Error('Impressora em estado de erro');
}

if (!status.ready) {
  throw new Error(status.message || 'Impressora não está pronta');
}
```

### Limitação importante

O DLE EOT é um mecanismo de status em tempo real do ESC/POS, mas o suporte e o mapa de bits podem variar por modelo, firmware e interface da MP-4200. O daemon retorna também `raw.n1` até `raw.n4` para diagnóstico.

As máscaras usadas nesta versão seguem o mapa Epson/Bematech mais comum. Antes de usar `paper: out` ou `ready: true` como garantia operacional, teste a unidade exata:

1. consulte com papel presente;
2. abra a tampa;
3. retire o rolo;
4. desligue a impressora;
5. compare os bytes em `raw`.

Se a impressora não responder ao DLE EOT, a resposta terá `status_supported: false` ou `reachable: false`. Nesse caso, trate o resultado como `unknown` e não como “pronta”. Uma conexão TCP aceita não garante que a impressora tenha papel.

O endpoint deve ser usado como **pré-verificação** e diagnóstico. Depois de enviar um trabalho, ainda mantenha os estados `sent_to_printer` e `unknown`: uma queda de conexão durante o envio pode ocorrer depois que parte do cupom já foi recebida.

## Templates e layouts por cliente

Os layouts ficam em:

```text
daemon/templates/
├── kitchen-default.json
├── courier-default.json
└── fiscal-default.json
```

O cliente pode alterar o arquivo JSON sem modificar o frontend. Depois de alterar um template, reinicie o daemon:

```bash
# Linux
sudo systemctl restart pdv-printer

# Desenvolvimento
# encerre e execute novamente: go run .
```

Blocos disponíveis nesta versão:

```text
text, separator, items, notes, customer, delivery,
payment, total, qrcode, feed, cut
```

Para um cliente com layout próprio, copie um template e configure seu ID:

```json
{
  "id": "kitchen-restaurante-abc",
  "version": 1,
  "destination": "kitchen",
  "columns": 48,
  "blocks": [
    {"type":"text","value":"COZINHA — {{order.number}}","align":"center","bold":true},
    {"type":"items"},
    {"type":"notes"},
    {"type":"feed","lines":3},
    {"type":"cut"}
  ]
}
```

Depois, aponte o destino no `config.json`:

```json
"kitchen": {
  "address": "192.168.1.50:9100",
  "template": "kitchen-restaurante-abc"
}
```

## Vários clientes ou estações

Cada computador que possui uma impressora deve ter sua própria instalação do daemon e seu próprio `config.json`.

Exemplo:

```text
Restaurante A / caixa 01
  daemon local → 192.168.1.50:9100

Restaurante B / cozinha
  daemon local → 192.168.2.50:9100
```

O frontend de cada cliente continua usando a mesma API local:

```text
http://127.0.0.1:8080
```

Somente a configuração local e os templates mudam.

## Segurança e operação

- O daemon escuta somente em `127.0.0.1` por padrão.
- O frontend não escolhe o endereço TCP da impressora.
- As origens CORS devem ser listadas explicitamente em `allowed_origins`.
- O daemon limita o corpo JSON a 512 KB e usa timeouts de rede.
- A fila usa SQLite local.
- O valor monetário usa centavos inteiros (`total_cents`).
- Não exponha a porta 8080 para a rede sem adicionar autenticação e uma política de acesso adequada.
- Valide a variante exata da MP-4200 quanto a codificação de acentos, corte, QR Code e conexão USB/Ethernet.
