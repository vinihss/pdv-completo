> **Nota:** documento histórico, escrito antes de transportes USB/CUPS, token, API v1, worker por impressora e polling web existirem no código. Use o README e `docs/` para o estado atual.

# Revisão do daemon de impressão

## Resumo executivo

O projeto é uma boa prova de conceito avançada para um daemon local de impressão de pedidos. Ele já resolve vários problemas importantes de operação:

- fila persistente em SQLite;
- idempotência por `order_id + destination`;
- retry com backoff exponencial;
- estados para diferenciar falha segura de possível impressão parcial;
- templates ESC/POS embutidos e sobrescrevíveis;
- serviço no Windows/Linux;
- endpoint de diagnóstico da impressora via DLE EOT;
- testes golden para preservar os bytes ESC/POS.

A limitação estrutural é clara: **o transporte está fixado em TCP**, principalmente em `sendTCP()` e `queryDLEEOT()`. O próprio README confirma que USB hoje só funciona mediante uma ponte que exponha a impressora como TCP. Portanto, a próxima versão deve introduzir uma camada de transporte, mantendo o payload ESC/POS independente da interface física.

## O que existe hoje

### Fluxo atual

```text
App React/Tauri ou navegador
        |
        | POST /api/print
        v
Daemon Go
  |-- valida destino e template
  |-- grava o trabalho no SQLite
  |-- renderiza ESC/POS
  |-- envia por TCP para host:porta
  |-- reprocessa falhas de conexão
  `-- consulta status por DLE EOT/TCP
```

### Pontos fortes

1. **Persistência local:** a fila sobrevive a reinicializações.
2. **Não depende do frontend:** o worker continua tentando mesmo com o navegador fechado.
3. **Proteção contra clique duplicado:** a chave única `(order_id, destination)` evita duplicação acidental do mesmo pedido.
4. **Tratamento prudente de falhas:** falhas de conexão são repetidas; falhas de escrita ficam em `reprint_confirmation`, evitando duplicação automática quando parte do cupom pode já ter sido recebida.
5. **Templates editáveis:** o cliente pode alterar layout sem recompilar o binário.
6. **Instalação operacional:** o Windows registra serviço automático e o Linux usa systemd.
7. **Diagnóstico:** `/health`, `/api/jobs` e `/api/printers/status` já fornecem uma base para a tela de suporte.

## Limitações e riscos encontrados

### 1. Não existe suporte USB nativo

A configuração só possui `address`, e o processamento chama diretamente:

```go
err = sendTCP(profile.Address, buffer)
```

O status também abre diretamente um socket TCP. Isso exclui:

- impressora USB instalada no Windows como impressora local;
- impressora exposta no Linux por CUPS;
- `/dev/usb/lp0` ou dispositivo serial/USB;
- múltiplas impressoras com nomes diferentes, mas sem IP.

### 2. O lock de processamento é global

`processMu sync.Mutex` serializa todas as impressões do daemon. Se a impressora da cozinha estiver desligada, uma tentativa com timeout pode atrasar também a impressora do caixa ou do motoboy.

O ideal é ter **uma fila/lock por impressora física**, permitindo que destinos independentes processem em paralelo, mas preservando a ordem dentro da mesma impressora.

### 3. A chave primária e a idempotência podem entrar em conflito

A tabela tem `id TEXT PRIMARY KEY` e `UNIQUE(order_id, destination)`. O `INSERT ... ON CONFLICT(order_id, destination)` atualiza o trabalho existente, mas não atualiza o `id`. Se o cliente reenviar o mesmo pedido com um novo `job_id`, pode surgir conflito de chave primária ou uma resposta inconsistente.

Recomendação: tratar `order_id + destination` como a identidade normal do trabalho e rejeitar `job_id` divergente, ou fazer uma atualização explícita e documentada. Para reimpressão intencional, usar `attempt/revision` separado.

### 4. O retorno HTTP mistura enfileiramento com envio físico

O endpoint tenta imprimir dentro da requisição. Em caso de falha, retorna `202`, mas em caso de sucesso retorna `sent_to_printer`. Isso é útil, porém o contrato deve deixar explícito que:

- `accepted`/`queued` significa aceito pelo daemon;
- `sent_to_printer` significa apenas que os bytes foram escritos no transporte;
- não há confirmação de que o papel saiu.

Para pedidos vindos da web, uma API assíncrona com `202 Accepted` sempre que o trabalho for persistido tende a ser mais resiliente e evita o navegador ficar aguardando timeout de impressora.

### 5. Segurança da API local

A API não possui autenticação. CORS reduz chamadas feitas por origens não autorizadas, mas não é autenticação e não protege contra todo software local ou contra uma origem permitida comprometida.

Mínimo recomendado:

- token local gerado na instalação, enviado em `Authorization: Bearer ...`;
- endpoint `/health` sem token, mas endpoints de impressão/configuração com token;
- limite de tamanho e validação estrita do payload;
- rejeição de destinos e templates desconhecidos;
- não permitir que o cliente escolha `address`, protocolo ou bytes arbitrários;
- logs sem dados sensíveis desnecessários;
- manter escuta em `127.0.0.1` por padrão.

### 6. Falta uma API de descoberta e configuração de impressoras

Hoje a instalação depende de editar JSON e conhecer o IP. Para operação semelhante ao iFood, o daemon deveria expor uma tela ou endpoints para:

- listar impressoras USB e impressoras instaladas no sistema;
- testar conexão;
- imprimir página de teste;
- associar uma impressora física a `kitchen`, `courier`, `fiscal`;
- escolher template e largura;
- salvar configuração atomicamente e criar backup.

A configuração deve continuar sendo local e controlada pelo daemon, não pelo frontend enviando endereço livre em cada pedido.

### 7. Status DLE EOT não é universal

O código reconhece os bits Epson/Bematech mais comuns e o README já documenta a limitação. Para USB/CUPS/Windows Spooler, o status de papel/tampa pode vir do driver, pode não existir, ou pode ser apenas `unknown`.

O contrato deve distinguir:

- `transport_reachable`: o canal abriu;
- `status_supported`: o canal/modelo informa sensores;
- `ready`: o status conhecido indica pronto;
- `unknown`: a impressão ainda pode funcionar, mas não há telemetria confiável.

Nunca tratar ausência de DLE EOT como prova de impressora sem papel.

### 8. Renderização ainda precisa de endurecimento

Antes de produção em vários clientes, recomendo acrescentar:

- codificação configurável (`cp850`, `windows-1252`, UTF-8 conforme o modelo);
- quebra de linha por largura real, inclusive nomes, observações e endereço;
- alinhamento/colunas com caracteres de largura variável;
- validação de `quantity`, valores negativos, campos excessivamente longos e número de itens;
- suporte opcional a imagem/logo;
- comandos ESC/POS configuráveis por perfil: corte, gaveta, QR Code, densidade;
- testes com acentos, caracteres especiais, pedido grande e papel de 58 mm/80 mm.

## Arquitetura recomendada

### 1. Separar o transporte por interface

Criar uma interface conceitual:

```go
type PrinterTransport interface {
    Open(ctx context.Context) (io.WriteCloser, error)
    Probe(ctx context.Context) (PrinterProbe, error)
    Name() string
}
```

Ou, de forma mais simples:

```go
type Transport interface {
    Send(ctx context.Context, data []byte) error
    Status(ctx context.Context) PrinterStatus
}
```

O pipeline ficaria:

```text
pedido JSON
  -> validação
  -> seleção do perfil
  -> seleção do template
  -> renderização ESC/POS
  -> transport.Send()
```

A renderização não deve saber se os bytes vão para TCP, USB ou CUPS.

### 2. Configuração de impressora por tipo

Substituir gradualmente `address` por algo como:

```json
{
  "printers": {
    "kitchen": {
      "transport": "tcp",
      "address": "192.168.1.50:9100",
      "template": "kitchen-default",
      "paper_width": 80,
      "encoding": "cp850",
      "status": true
    },
    "counter": {
      "transport": "windows_spooler",
      "printer_name": "Elgin MP-4200",
      "template": "counter-default",
      "paper_width": 80,
      "status": true
    },
    "backup": {
      "transport": "cups",
      "printer_name": "ELGIN_USB",
      "template": "kitchen-default"
    }
  }
}
```

Manter compatibilidade: se `transport` estiver ausente e `address` estiver preenchido, assumir `tcp`.

### 3. Backends por sistema operacional

#### Windows: recomendado

Para impressoras USB instaladas no Windows, o caminho mais confiável é o **Windows Print Spooler em modo RAW**, não acesso direto ao dispositivo USB.

Implementação:

- backend Go específico para Windows usando `OpenPrinter`, `StartDocPrinter`, `StartPagePrinter`, `WritePrinter`, `EndPagePrinter`, `EndDocPrinter`;
- `pDatatype = "RAW"`, para enviar ESC/POS sem o driver transformar o conteúdo;
- configuração por nome da fila, por exemplo `Elgin MP-4200`;
- descoberta via enumeração de impressoras instaladas;
- estado básico via `GetPrinter`/fila do Windows;
- status ESC/POS opcional somente quando o driver/interface permitir.

Vantagem: o instalador USB, permissões e spooler já são gerenciados pelo Windows. O daemon não precisa descobrir VID/PID nem disputar o dispositivo com o driver.

#### Linux: recomendado

Oferecer duas opções, em ordem de preferência:

1. **CUPS:** enviar RAW para uma fila configurada, usando IPP/Unix socket ou comando/integração nativa. É o caminho mais compatível com permissões e administração do sistema.
2. **USB direto:** usar `/dev/usb/lp*` somente como backend avançado, com regra udev, grupo/permissão e controle de exclusão do dispositivo.

O suporte Linux deve informar claramente que status de sensores pode ser `unknown` quando o CUPS/driver não devolver DLE EOT.

#### Ponte TCP

Continuar suportando TCP 9100 como backend principal para impressoras de rede. Para uma primeira versão USB, uma ponte local pode ser usada como solução de transição, mas não deve ser o desenho final: ela cria outro serviço, mais um ponto de falha e mais dificuldade de suporte.

## Fila e concorrência recomendadas

Criar um worker por `printer_id` físico:

```text
kitchen -> impressora USB A -> worker serial
courier -> impressora IP B  -> worker serial
fiscal  -> impressora IP C  -> worker serial
```

Se dois destinos apontarem para a mesma impressora física, eles devem compartilhar o mesmo worker e a mesma ordem. Isso evita intercalar bytes de dois cupons.

Adicionar à tabela:

- `printer_id`;
- `transport`;
- `payload_hash`;
- `attempt_started_at`;
- `completed_at`;
- `failure_class`;
- `reprint_revision`;
- `receipt_id`/`external_event_id` para correlacionar o pedido vindo do app ou da web.

Também recomendo uma migração explícita com versão, em vez de depender apenas de `ALTER TABLE` ignorado.

## API sugerida para a próxima versão

### Impressão

```http
POST /api/v1/print
Authorization: Bearer <token>
Content-Type: application/json
```

Resposta após persistir:

```json
{
  "job_id": "pedido-123-kitchen",
  "status": "accepted",
  "queue_status": "queued"
}
```

### Consulta

```http
GET /api/v1/jobs/{job_id}
GET /api/v1/jobs?status=retry_waiting&limit=100
```

### Impressão de teste

```http
POST /api/v1/printers/{printer_id}/test
```

### Descoberta

```http
GET /api/v1/printers/discover
GET /api/v1/printers
PUT /api/v1/printers/{printer_id}
```

O endpoint de descoberta deve retornar dados não sensíveis e não deve ativar impressão automaticamente.

### Eventos para o frontend

Para o app local, pode-se adicionar SSE ou WebSocket:

```text
job accepted -> printing -> sent_to_printer
                         \-> retry_waiting
                         \-> reprint_confirmation
```

Isso evita polling agressivo de `/api/jobs`.

## Fluxo para pedidos vindos do app e da web

### App desktop/Tauri

O fluxo atual é adequado: o app chama `127.0.0.1` diretamente. A melhoria principal é autenticação por token e API versionada.

### Web/PWA

O navegador também pode chamar o daemon local, mas a impressão automática disparada exclusivamente pelo backend em nuvem não alcança um daemon que está na loja. Para autoimpressão real, escolher uma destas arquiteturas:

1. **Daemon faz polling/outbox:** o daemon local autentica na API e busca novos eventos de impressão.
2. **WebSocket/SSE iniciado pelo daemon:** a conexão sai da loja para a nuvem, atravessando NAT sem abrir porta de entrada.
3. **Gateway local:** um agente autenticado mantém uma conexão persistente com o backend.

A melhor opção para operação estilo iFood é a primeira ou a terceira: o daemon local mantém uma conexão de saída, recebe o pedido e persiste imediatamente na fila. Não depender de o navegador estar aberto.

## Plano de implementação por fases

### Fase 1 — endurecer o núcleo

- corrigir o contrato de idempotência `job_id`/`order_id`;
- separar `render`, `queue` e `transport` em pacotes;
- trocar o lock global por worker por impressora física;
- adicionar validação de payload e API `/api/v1`;
- adicionar token local;
- acrescentar testes de concorrência, restart, retry e pedidos grandes;
- corrigir/confirmar codificação e quebra de linha.

### Fase 2 — USB no Windows

- implementar `windows_spooler` RAW;
- listar impressoras instaladas;
- salvar `printer_name` no perfil;
- botão/end-point de teste;
- instalador incluir apenas o binário correto por arquitetura;
- testar Windows 10/11 com MP-4200 USB, tampa aberta, sem papel, fila pausada e impressora desligada.

### Fase 3 — USB no Linux

- implementar backend CUPS;
- documentar criação e permissões da fila RAW;
- adicionar backend `/dev/usb/lp` apenas se houver demanda real;
- incluir diagnóstico de permissões e nome da fila.

### Fase 4 — autoimpressão web confiável

- daemon se autentica na nuvem com credencial por loja/estação;
- canal de saída persistente ou polling com cursor;
- eventos deduplicados por `external_event_id`;
- confirmação de recebimento do evento e observabilidade;
- sincronização segura da configuração de impressoras.

## Critérios de aceite

O daemon estará pronto para produção quando conseguir:

- imprimir o mesmo pedido em IP e USB sem alterar o payload do app;
- reiniciar durante uma fila e continuar sem perder trabalhos;
- manter a cozinha funcionando mesmo com o caixa offline;
- impedir interleaving quando dois pedidos chegam juntos à mesma impressora;
- listar e testar uma impressora USB pelo nome do sistema;
- distinguir `offline`, `driver_paused`, `status_unknown` e `possible_partial_print`;
- permitir reimpressão explícita sem duplicar automaticamente;
- registrar logs correlacionados por loja, impressora e `job_id`;
- funcionar para a web sem depender de uma aba aberta, por conexão iniciada pelo daemon;
- passar testes em impressora real, não apenas em mock TCP.

## Conclusão

**Sim, o projeto pode evoluir para um daemon no padrão operacional desejado**, mas USB não deve ser implementado como uma condição dentro de `sendTCP`. A decisão arquitetural central é criar uma interface de transporte e dois backends de primeira classe:

- `tcp9100` para IP;
- `windows_spooler` para USB no Windows;
- `cups` para Linux.

A recomendação prática é começar pelo **Windows Spooler RAW**, porque o pacote distribuído já é orientado a Windows e o Spooler é mais estável para impressoras USB do que acesso direto ao dispositivo. Em paralelo, o daemon deve passar a usar workers por impressora, API autenticada/versionada e um canal de saída iniciado pelo próprio daemon para viabilizar a impressão automática dos pedidos vindos da web.

> Observação de validação: a suíte `go test ./...` e `go vet ./...` não pôde ser executada neste ambiente de revisão porque o compilador Go não está instalado (`go: command not found`). A análise foi feita por inspeção do código, testes, configuração, scripts e pacote Windows distribuído.
