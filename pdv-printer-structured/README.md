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

Linux:

```bash
sudo ./scripts/install-linux.sh
```

Windows: abra o PowerShell como Administrador:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

O pacote é somente fonte e scripts. A instalação Windows pode compilar o daemon se Go estiver instalado ou receber um binário por `-Binary`.

## Limitações conhecidas

- CUPS não fornece necessariamente sensores ESC/POS DLE EOT; o status pode ser `unknown`.
- O callback de status cloud é enviado após o processamento, mas uma outbox persistente de callbacks é uma evolução futura.
- A confirmação `accepted` significa que o job foi persistido localmente; não confirma que o papel saiu.
