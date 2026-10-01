# PDV Printer Daemon

Daemon local de impressão ESC/POS para integração com React/Tauri, navegador/PWA e backend de impressão web automática.

## Estrutura

```text
pdv-printer-structured/
├── daemon/
│   ├── main.go                 # API HTTP, fila SQLite e renderização ESC/POS
│   ├── cloud.go                # polling autenticado e deduplicação web
│   ├── transport_windows.go    # Windows Print Spooler RAW
│   ├── transport_cups.go       # CUPS Linux via lp -o raw
│   ├── transport.go            # contrato de transporte
│   ├── templates/              # templates ESC/POS embutidos
│   ├── testdata/               # fixtures e golden tests
│   ├── go.mod
│   └── go.sum
├── scripts/
│   ├── install-linux.sh
│   └── install-windows.ps1
└── docs/
    ├── CUPS_LINUX.md
    ├── WEB_AUTOMATIC_PRINT.md
    └── Revisão do daemon de impressão.md
```

## Build e testes

Requer Go 1.22+.

```bash
cd daemon
go test ./...
go test -race ./...
go vet ./...
go build -trimpath -ldflags='-s -w' -o pdv-printer-daemon .
```

Build Windows a partir do Linux:

```bash
cd daemon
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -ldflags='-s -w' -o pdv-printer-daemon.exe .
```

## Configuração

```bash
cd daemon
cp config.example.json config.json
```

Edite `config.json` e configure ao menos um perfil em `printers`.

- Rede: `transport: "tcp"` e `address: "host:9100"`;
- Windows USB: `transport: "windows_spooler"` e `printer_name`;
- Linux USB/CUPS: `transport: "cups"` e `printer_name` igual ao nome da fila CUPS.

Não versione `config.json` nem tokens.

### Token da API local

Na primeira execução sem `config.json`, o daemon cria um com `api_token` aleatório (256 bits). O instalador do Windows também gera um. O PDV deve enviar `Authorization: Bearer <api_token>` em `/api/*` (`/health` continua aberto). O token também pode vir de `PDV_API_TOKEN`.

Configs antigos com `api_token` vazio continuam funcionando, mas o daemon avisa no log. Independentemente do token, requisições de navegador com `Origin` fora de `allowed_origins` recebem `403`; clientes sem `Origin` (curl, app Tauri via Rust) não são afetados.

### Codificação do cupom (acentos)

Térmicas ESC/POS não entendem UTF-8. Cada perfil aceita:

- `encoding`: `cp850` (padrão), `cp858`, `windows-1252` ou `utf-8` (sem conversão);
- `code_page`: número de `ESC t n`, se o modelo não seguir a tabela Epson (cp850=2, cp858=19, windows-1252=16).

Teste com um pedido contendo "Ç Ã Õ É" na impressora real. Se sair errado, ajuste `code_page` conforme o manual do modelo.

O texto do pedido é sanitizado: caracteres de controle (corte, gaveta etc.) são removidos antes de chegar à impressora.

## Impressão web automática

Ative `cloud.enabled`, configure `base_url`, `station_id` e o token da estação. O daemon inicia polling de saída, grava eventos na fila local, deduplica por `external_event_id + destination`, envia ACK após persistência e reporta o status posterior do job.

Para manter o token fora do JSON:

```bash
export PDV_CLOUD_TOKEN='token-da-estacao'
```

Consulte `docs/WEB_AUTOMATIC_PRINT.md` para o contrato do backend.

## Linux/CUPS

```bash
sudo apt install cups cups-client
sudo systemctl enable --now cups
lpstat -p
```

Consulte `docs/CUPS_LINUX.md` para permissões, filas RAW e diagnóstico.

## Instalação como serviço

Linux (o daemon cria o `config.json` com token na primeira execução):

```bash
sudo ./scripts/install-linux.sh
```

Windows: abra o PowerShell como Administrador:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

O executável Windows agora implementa o protocolo de serviço (`svc.Run`): o Service Control Manager recebe `Running` e `Stop`, e o log vai para `%ProgramData%\PDV Printer\daemon.log`. **Os binários não acompanham este pacote**; compile com os comandos acima antes de instalar. A instalação Windows compila o daemon se Go estiver instalado ou recebe um binário por `-Binary`.

## Garantias de impressão

- Um job só é impresso por quem consegue mudá-lo para `printing` (UPDATE condicional); HTTP, nuvem e retry worker não duplicam o cupom.
- Jobs encontrados em `printing` na subida (queda no meio do envio) vão para `reprint_confirmation`: o operador confirma se o papel saiu.
- Retry automático só quando nenhum byte chegou à impressora (TCP recusado, CUPS recusou o job, spooler não abriu o documento), em qualquer transporte. Esgotadas as tentativas o job fica `failed`. Falha no meio da escrita vai para `reprint_confirmation`.

## Limitações conhecidas

- O renderizador Rust do app (`frontend/src-tauri`) precisa aplicar a mesma conversão de code page e sanitização; o golden test cobre apenas o render lógico em UTF-8 (`render()`).
- CUPS não fornece necessariamente sensores ESC/POS DLE EOT; o status pode ser `unknown`.
- O callback de status cloud é enviado após o processamento, mas uma outbox persistente de callbacks é uma evolução futura.
- A confirmação `accepted` significa que o job foi persistido localmente; não confirma que o papel saiu.
