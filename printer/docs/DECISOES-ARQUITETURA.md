# Decisões de arquitetura — PDV Printer Daemon

Status: proposta consolidada para a remontagem do daemon.
Escopo: `printer/daemon/` (Go 1.22+, binário único, serviço Windows nativo + systemd).

Este documento substitui `comversa-gemini.md` como referência de projeto. A
conversa é um rascunho de IA com decisões conflitantes entre si e com o código
que já existe no repositório; aqui ficam as decisões que valem, com o motivo.

---

## 0. Ponto de partida: a árvore não compila

`go build ./...` em `printer/daemon/`:

```
./encoding.go:75:6   GenerateQRCodeCommand redeclared in this block
./encoding.go:94:6   ImageToESCPOS redeclared in this block
./logger.go:12:6     SetupLogger redeclared in this block (gemini-code-1790818391502.go:13)
./cloud.go:39:18     undefined: PrintRequest
./cloud.go:97:10     undefined: Daemon
./spooler.go:54      undefined: Transport
./golden_test.go:143 expected '(', found GenerateQRCodeCommand
```

Três linhagens em conflito:

| Linhagem | Conteúdo | Onde |
|---|---|---|
| **A** | Daemon real, 1008 linhas em `main.go`: SQLite, `migrate`, renderer ESC/POS, `encoder` com code page, DLE EOT, CORS, 6 rotas | `git show a4817e1:printer/daemon/main.go`; também em `origin/copilot/fix-build-desktop-job`, `origin/feature/chat`, `origin/feature/iversion` |
| **B** | Esqueleto do Gemini: BoltDB, `/print`, `/health`, `UpdateURL` placeholder, `/templates/sync` | commit `aa7b86c`, que sobrescreveu A (1008 → 130 linhas) |
| **C** | Daemon "Lineage D": `cloud.go`, `monitor.go`, `transport*.go`, `service_windows.go`, `encoding.go` e **7 arquivos de teste** | HEAD — escrito contra um `main.go` que nunca foi commitado |

Verificado por varredura de todos os objetos git (`git rev-list --objects --all`,
13 branches, sem stash, reflog com 1 entrada): `claimJob`, `encoderFor`,
`sanitizeText`, `validatePrintRequest`, `statusMonitor`, `lockPrinter`,
`sendTCPContext`, `queryDLEEOTContext`, `profileConfigured`, `newAPIToken` não
existem em nenhum ponto do histórico. A lineage C **é** a fonte da verdade
funcional.

Três clientes reais já dependem do contrato da lineage C e são o critério de
correção mais forte que temos:

- `backend/src/integrations/printer/printer.client.ts` — `/api/print`,
  `/api/printers/status`, tags JSON de `DaemonPrinterStatus`.
- `frontend/src/entities/printer/api/printer.js` e `lib/daemonOrder.js` —
  `job_id = ${orderId}-${destination}`.
- `frontend/src-tauri/src/printing/escpos.rs` + `tests/golden.rs` — espelho
  byte-a-byte do renderer; os comentários citam `main.go:71` (`Block`), `:118`
  (`PrintRequest`), `:817` (`render`), `:896` (`expand`), `:905` (`escpos`), o que
  casa linha a linha com `a4817e1`.

---

## 1. Decisões

Formato: ADR curto. **Mantida** = já está no código ou nos testes; **Nova** =
precisa ser implementada; **Rejeitada** = proposta do Gemini que não entra.

### ADR-01 — Go, binário único, serviço nativo

**Mantida.** Compila para Windows e Linux sem runtime; <30 MB de RAM. O Windows
exige serviço real: `service_windows.go` implementa `svc.Handler.Execute` com
`StartPending → Running(AcceptStop|AcceptShutdown) → StopPending` e timeout de
15 s no stop, porque um exe de console faz `sc start` falhar com erro 1053.

**Consequência:** existe `runDaemon(ctx) error` como entrada única. `main()`
decide console vs serviço via `runAsWindowsService` (`service_windows.go:72`).

### ADR-02 — Fila em SQLite, não BoltDB

**Rejeitada a proposta do Gemini (BoltDB).** Decisão: `modernc.org/sqlite`
(puro Go, sem CGO — constraint do cross-compile Windows a partir de Linux).

Motivos, todos verificáveis:

1. O daemon já tem **três tabelas** com SQL real: `print_jobs`,
   `external_events`, `cloud_state` (`cloud.go`, `monitor.go`).
2. **Dedup** é `UNIQUE(order_id, destination)` e `ON CONFLICT ... DO NOTHING` /
   `DO UPDATE`. Chave-valor não dá isso sem reinventar índices à mão.
3. **Claim atômico** depende de `UPDATE ... WHERE id=? AND status IN (...)` com
   `RowsAffected()`. `hardening_test.go:98-126` exige que 16 goroutines
   concorrentes resultem em exatamente 1 claim.
4. O teste de migração (`cloud_events_test.go:228-251`) faz `ALTER TABLE
   external_events DROP COLUMN` e exige backfill — impossível em KV.
5. BoltDB abre **um único writer**; com polling de nuvem + worker de retry +
   monitor de status na mesma instância, serializar tudo atrás do mesmo lock é
   uma taxa de falhas avoidable.

O `spooler.go` do Gemini é apagado. A ADR do Gemini ("BoltDB roda dentro do
processo, ACID") descreve uma propriedade verdadeira — e irrelevante: o
requisito é *consultar e atualizar estado por transação*, não "gravar bytes".

### ADR-03 — Máquina de estados + claim condicional

**Mantida (implícita nos testes, explícita no código de nuvem).**
Vocabulário de `print_jobs.status`:

```
queued ──claim──► printing ──ok──► sent_to_printer
   ▲                  │
   │                  ├──erro transitório, tentativas < max──► retry_waiting ─┐
   │                  ├──erro transitório, tentativas esgotadas──► failed     │
   │                  ├──falha no meio da escrita──► reprint_confirmation    │
   │                  └──estado físico bloqueante──► blocked_printer ────────┘
   └──────────────────────── unblockPrinterJobs (monitor recuperou) ──────────┘
```

Regras:

- `claimJob(jobID)` é um **UPDATE condicional** que aceita `queued` **e**
  `retry_waiting`, incrementa `attempts` e devolve `(attempts int, claimed bool,
  err error)`. Os testes descartam o 1º retorno; `int` é o tipo que `process`
  precisa para decidir `retry_waiting` × `failed` sem releitura.
- `claimJob` **ignora `next_attempt_at`**. O filtro de vencimento pertence só a
  `processDueJobs`. Isso é forçado por
  `TestProcessRetryEDeposFalhaSemPapelParcial`: duas chamadas a `process` em
  sequência imediata precisam avançar até `failed` com `base_delay_seconds: 1`.
- `recoverInterruptedJobs()` roda no boot, transiciona `printing` →
  `reprint_confirmation` e devolve a contagem. Ocupado não pode ser retomado pelo
  worker sozinho: o operador confirma se o papel saiu.
- `finishJob` é UPDATE **incondicional** por `id` (o teste o chama sobre um job
  em `retry_waiting`).

### ADR-04 — Idempotência em dois níveis

**Mantida.** Um cupom duplicado é o pior defeito possível num PDV.

1. `external_events`: `UNIQUE(external_event_id, destination)` com
   `ON CONFLICT DO NOTHING`; `RowsAffected()==0` ⇒ duplicata, devolve o
   `job_id` existente. Duplicata da nuvem não vira job novo.
2. `print_jobs`: `UNIQUE(order_id, destination)`. Reenvio **re-enfileira**
   (volta a `queued`, `attempts=0`, payload/template atualizados, `id`
   preservado). `frontend/src/entities/printer/lib/daemonOrder.js:109-113`
   documenta exatamente essa semântica e o `job_id` derivado
   (`${orderId}-${destination}`).
3. `payload_hash` (SHA-256 do `json.Marshal(req)`) detecta conflito real:
   mesmo `(order_id, destination)` com conteúdo diferente é
   `errIdempotencyConflict`, ACK `rejected`, **cursor avança**.

### ADR-05 — Retry só quando nenhum byte saiu

**Mantida.** O modelo `transientError` em `transport.go:9-29` é independente de
transporte e é a decisão mais importante do daemon:

> Falha no meio da escrita pode ter impresso metade do cupom. Repetir duplicaria
> papel. Logo, retry automático **só** quando nenhum byte chegou à impressora.

Consequências obrigatórias:

- `markTransient` em falha de dial TCP, fila CUPS que recusou o job, spooler que
  não abriu o documento. **Não** em falha de `WritePrinter` nem de escrita parcial.
- Tentativas esgotadas sem byte enviado ⇒ **`failed`**, não `reprint_confirmation`.
  `a4817e1` erra aqui; os testes corrigem.
- Backoff exponencial com teto (`base_delay_seconds` → `max_delay_seconds`).

### ADR-06 — ACK significa "persistido", status é DB-driven

**Mantida.** Distinção que a nuvem precisa:

- ACK `accepted` = o job está **no disco local**. Não significa que o papel saiu.
- ACK `rejected` + motivo = erro permanente (destino sem impressora, template
  inexistente, payload inválido, conflito de idempotência). **O cursor avança**,
  senão um evento ruim bloqueia a estação para sempre.
- Erro transitório (falha de banco) ⇒ sem ACK, cursor **não** avança, o evento é
  redelivered.
- O status posterior é lido do **banco**, não do evento:
  `reportPendingStatuses` faz `JOIN external_events × print_jobs` onde
  `reported_status <> status`, `LIMIT 50`, e só escreve `reported_status` após
  POST 2xx. É por isso que o callback precisa de outbox no mesmo banco.
- Drenar todas as linhas antes de qualquer chamada HTTP é obrigatório: o pool
  está com `MaxOpenConns(1)` (adquirido em `cloud.go:288-311`).

### ADR-07 — Code page explícita, com fallback ASCII

**Mantida.** Térmicas ESC/POS não entendem UTF-8.

```go
type encoder struct { codePage int; table string; asciiFallback map[rune]string }
// cp850High, cp858High, cp1252High — 128 runes cada (U+0080..U+00FF)
func encoderFor(profile PrinterProfile) (*encoder, error)   // utf-8 ⇒ (nil, nil)
```

- `encoding`: `cp850` (padrão), `cp858`, `windows-1252`, `utf-8`. Case-insensitive.
- `code_page`: `*int`, sobrepõe o `ESC t n` derivado. Faixa 0–255, erro fora.
- `utf-8` devolve `nil` **sem erro** ⇒ `render()` é o render lógico UTF-8,
  byte-idêntico a `renderForProfile` com perfil utf-8. É isso que torna os
  goldens válidos e o espelho Rust possível.
- CP1252 tem 5 bytes indefinidos (`0x81 0x8D 0x8F 0x90 0x9D`) ⇒ precisam cair
  em `?`/fallback.
- `sanitizeText` roda **antes** de tudo, inclusive no QR: remove C0 exceto `\n`,
  converte `\t` em espaço, remove `0x7F`. Sem isso, um nome de item com `\x1d`
  injeta comandos ESC/POS na impressora.

### ADR-08 — Templates declarativos, embed + override por id

**Mantida.** Formato: objeto plano com `id`, `version`, `destination`,
`columns`, `blocks[]`. 11 block types: `text`, `separator`, `items`, `notes`,
`customer`, `delivery`, `payment`, `total`, `qrcode`, `feed`, `cut`. Qualquer
outro ⇒ erro.

Ordem de carga: `//go:embed templates/*.json` primeiro (o daemon **precisa**
subir mesmo sem `templates_dir` no disco), depois `TemplatesDir` sobrescreve **por
`id`**. `templateFor(id, destination)` exige `t.Destination == destination`;
com `id` vazio, primeiro template do destino.

> O `addQRCode` inline de `a4817e1:940-953` é o que casa com o golden
> (`1d 28 6b ... 31 45 30`). `GenerateQRCodeCommand` em `encoding.go` emite
> `31 44 <ec>` — **byte diferente**. `render` não pode delegar a ela.

### ADR-09 — Transporte como interface, 3 implementações

**Mantida.**

```go
type PrinterTransport interface {
    Send(context.Context, []byte) error
    Query(context.Context, byte) (byte, error)   // DLE EOT; indisponível → erro
    Description() string
}
```

| Transporte | Mecanismo | `Query` |
|---|---|---|
| `tcp` / `tcp9100` | `net.Dialer` → porta 9100 RAW | **DLE EOT** `10 04 n`, n=1..4 |
| `windows_spooler` | `winspool.drv`: `OpenPrinterW`/`StartDocPrinterW`(`RAW`)/`StartPagePrinter`/`WritePrinter` | não exposto → erro explícito |
| `cups` | `lp -d <fila> -o raw -` (nome como argv separado, **nunca shell**) | não exposto → `status_supported=false` |

`Query` recusado **não** significa "sem papel": o status report precisa de
`status_supported=false`, não de inferência negativa.

### ADR-10 — Lock por impressora física, não global

**Nova.** `a4817e1` usava `d.processMu` global (serializa todas as impressoras).
`printer/docs/Revisão…md:65-69` condena isso e `monitor.go:62,82` já chama
`d.lockPrinter(profile, destination) func()`.

A chave é a **impressora física** (`profile.PrinterID`, senão
`<transport>:<address|printer_name>`, senão `destination:<nome>`) — duas
destinos na mesma impressora (`kitchen` e `courier` na `192.168.1.50`) travam
um ao outro, que é o comportamento correto: um corpo de impressão por vez.

### ADR-11 — Bind local + token + CORS com 403 ativo

**Mantida.** A API local do daemon é exposta ao navegador (Tauri, PWA).

- `listen` padrão `127.0.0.1:8080` — não `0.0.0.0`.
- `api_token` gerado na primeira execução: 32 bytes `crypto/rand` em hex (64
  chars, 256 bits). O `Config` retornado e o arquivo gravado têm de conter **o
  mesmo** token — `a4817e1:224-247` tem esse bug (chama `defaultConfig()` duas
  vezes e gera dois tokens; o cliente usaria um token que o restart não
  reconhece).
- `Authorization: Bearer <token>`; `/health` fica fora. Token vazio = compat
  (aviso no log). Fallback `PDV_API_TOKEN`.
- `withCORS` precisa do **upgrade de `a4817e1`**: `Origin` desconhecida ⇒
  **403** e handler não chamado. Só cabeçalhos CORS não bastam: `POST`
  `text/plain` é "simples" e **dispensa preflight** — um site qualquer
  imprimiria no restaurante. Preflight `OPTIONS` ⇒ 204 com
  `Access-Control-Allow-Headers: "Content-Type, Authorization"` e
  `Access-Control-Allow-Private-Network: true`. Sem `Origin` (curl, Tauri/Rust)
  segue normal.

### ADR-12 — Descoberta só de plataforma; varredura de sub-rede rejeitada

**Rejeitada a proposta do Gemini** (`/printers/discover` varrendo `.1`–`.254` de
cada sub-rede). Motivos: 254 goroutines por interface em toda partida; `net.LookupAddr`
bloqueante (DNS de rede local, sem timeout) dentro de cada uma; falsos positivos
de qualquer serviço na 9100; e nada disso é necessário — o técnico sabe qual é a
impressora.

**Mantida:** `discoverPlatformPrinters()` — `EnumPrintersW` (nível 4, local +
conexões) no Windows, `lpstat -p` + `parseLPStatPrinters` no Linux. Exposta em
`GET /api/v1/printers/discover`; fora de Windows/Linux ⇒ **501**. Linux com CUPS
instalado responde 200 — o teste de 501 faz skip em Linux de propósito.

### ADR-13 — `TemplateManager` em disco: sem callers, design paralelo

**Rejeitada.** `template_manager.go` está 100% morto (`NewTemplateManager`,
`SaveTemplate`, `GetTemplate`: zero call sites). Ele compete com o mecanismo
`embed` + override, que já resolve versionamento e fallback. E a rota
`/templates/sync` que o justificaria **não existe no contrato real** — nenhum
cliente a consome, e ela permitiria trocar o layout do cupom por HTTP.

Se a loja precisar editar layout sem técnico, o caminho certo é `TemplatesDir`
(versionado no `config.json`), não um endpoint de escrita.

### ADR-14 — Rotas: contrato real, `/print` e `/health` saem

**Rejeitada a proposta do Gemini.** Hoje existem exatamente duas rotas, ambas
erradas: `/print` **nunca lê `r.Body`** (o payload é sempre `nil` — nada é
renderizado) e `/health` retorna `{"status":"online"}` sem token, sem origens, sem
consultar a fila. `install-windows.ps1:362` e os três clientes leem campos que não
existem.

| Rota | Método | Token |
|---|---|---|
| `/health` | GET | não |
| `/api/print` | POST | sim |
| `/api/jobs` | GET | sim |
| `/api/jobs/retry` | POST | sim |
| `/api/printers/status` | GET | sim |
| `/api/templates` | GET | sim |
| `/api/v1/printers/discover` | GET | sim |

`/health` responde `{"status":"ok","printers":[...],"ready":bool,"templates":n,"queue_depth":n}`
— `status` **precisa** ser `"ok"`, não `"online"`. `ready` é
`profileConfigured(profile)` de cada perfil, com `TrimSpace`: perfil sem endereço
(ou só espaços) ⇒ `ready:false` = "instalação nova", não mandar para endereço
herdado de outra loja.

Validação de payload (`validatePrintRequest`) é obrigatória, com constantes
nomeadas `maxItemName`, `maxItemNotes`, `maxAddons`, `qrMaxBytes`:

- `qrMaxBytes` **≤ 65533**. `storeLen = len+3` estoura o par de 16 bits e o resto
  do payload vazaria como comando ESC/POS. Um QR de 65 538 bytes tem de fazer
  `render` falhar.
- `Order.Notes` ≤ 2000, `Delivery.Address` ≤ 300, `TotalCents`/`ChangeCents` ≥ 0.

### ADR-15 — Auto-update: verificação **antes** de aplicar

**Rejeitada a implementação do Gemini.** `updater.go:64-80` faz
`selfupdate.Apply(io.TeeReader(body, hasher))` e **só depois** compara o SHA256.
O `Apply` consome o stream e substitui o executável; num checksum divergente a
função retorna erro e a máquina fica rodando **o binário não verificado**.
`selfupdate.Options{}` vazio ⇒ nenhuma verificação de procedência.

Decisão para a remontagem:

1. Baixar para arquivo temporário.
2. SHA256 **e** assinatura (minisign) conferidos **antes** de tocar no executável.
3. Só então `selfupdate.Apply`, com `selfupdate.RollbackError` em falha.
4. `UpdateURL` hoje é `https://api.meusistema.com/daemon/latest.json` — domínio
   placeholder, hardcoded, sem override. Vai para `config.json` (ou env), e o
   `CurrentVersion` passa a ser injetado por `-ldflags` em vez de `const`.
5. `RestartDaemon` usa `net stop/start PDVDaemon`, mas o serviço se chama
   `PDVPrinterDaemon` (`service_windows.go:16`) — nomes divergentes, o restart
   nunca funcionou.
6. Checar `StatusCode` no manifesto e no download (hoje não há checagem).

### ADR-16 — Logs: um setup só

**Rejeitada a duplicata.** `SetupLogger` está declarado duas vezes
(`logger.go:12` e `gemini-code-1790818391502.go:13`) e **nenhuma** tem call site.
O código vivo usa `log.Printf` (`main.go`, `cloud.go`, `service_windows.go`) e
`slog.Info` default (`spooler.go`, `updater.go`) — ou seja, o log JSON que o
README e o `MANIFEST.txt` prometem nunca é configurado.

Decisão: `slog` JSON + rotação (`lumberjack`), um único setup, caminho derivado da
localização do `config.json` (`%ProgramData%\PDV Printer\daemon.log` no serviço
Windows). `main.go`, `cloud.go` e `monitor.go` passam a usar `slog` com
`logger.With(...)` em vez de `log.Printf("[MAIN] …")`.

---

## 2. Estratégia de remontagem

Cinco fases, cada uma com verificação própria. `go test ./...` é o portão da
última, mas as fases 1 e 2 já exigem `go build` verde.

### Fase 1 — Desbloquear o build (obrigatória, sem decisão de projeto)

Nada aqui é arquitetura; é o commit `aa7b86c` colando blocos de código duas vezes.

1. `encoding.go`: remover as declarações duplicadas de `GenerateQRCodeCommand`
   (linha 75) e `ImageToESCPOS` (linha 94).
2. `golden_test.go`: remover linhas **143–194** — as duas funções coladas dentro
   de `TestFixtureCobreTodosOsBlocos`. Go não permite declaração de função dentro
   de função; é o que produz `expected '(', found GenerateQRCodeCommand`.
3. Apagar `gemini-code-1790818391502.go` (cópia verbatim da conversa) e
   `gemini-code-1790817991451.go` (já deletado no índice, duplicata de
   `spooler.go`).
4. `go.mod`: reintroduzir `modernc.org/sqlite` (o commit `aa7b86c` removeu o
   driver; `main_test.go:179` faz `sql.Open("sqlite", …)`).

Depois da fase 1, `go build` ainda falha com `undefined: Daemon` etc. — isso é a
fase 2.

### Fase 2 — Reconstruir o `main.go` da lineage D

Base: `git show a4817e1:printer/daemon/main.go` (1008 linhas) como ponto de
partida, mais o que `cloud.go`, `monitor.go`, `transport*.go` e os 7 testes exigem.
Não é código novo: é a linhagem A + os deltas que a linhagem C impõe.

Em ordem, porque cada bloco destrava o próximo:

1. **Tipos**: `Config`, `StatusMonitorConfig`, `RetryConfig`, `PrinterProfile`
   (`CodePage *int`), `PrinterStatus`, `Template`, `Block`, `Item`, `Order`,
   `PrintRequest`, `Daemon`, `encoder`, `escpos`.
   `Daemon` tem de funcionar como **literal de valor zero** (`&Daemon{}` em
   `phase2_test.go:27`): `healthCache` e o mapa de locks se auto-inicializam.
2. **Caminhos e config**: `mustAbs`, `resolveDir`, `defaultConfigPath`,
   `resolveConfigPath`, `loadConfig`, `ensureConfig`, `newAPIToken`.
   `resolveDir` respeita caminho com raiz em qualquer S.O. (o `filepath.IsAbs`
   sozinho erra no Windows — `main_test.go` fixa os 6 casos).
   `ensureConfig` preserva config do cliente sem mesclar e grava o **mesmo**
   token que devolve em memória.
3. **Banco**: `migrate(db)` — as 3 tabelas, `CREATE TABLE IF NOT EXISTS` +
   `ALTER TABLE ADD COLUMN` com erro ignorado, e o backfill de `reported_status`
   guardado por `WHERE reported_status IS NULL` (senão a 2ª execução reenvia
   histórico — que é o que `TestMigracaoNaoReenviaHistoricoDeStatus` nomeia).
   Colunas que `monitor.go` exige e `a4817e1` não tem: `printer_id`,
   `payload_hash`, `blocked_reason`.
4. **Templates**: `embeddedTemplates` (`//go:embed`), `loadTemplates`,
   `parseTemplate`, `templateFor`.
5. **Encoder**: `encoderFor`, `(*encoder).encode`, as 3 tabelas de 128 runes,
   `sanitizeText`.
6. **Renderer**: `render` ≡ `renderWith(t, o, nil)`, `renderForProfile` ≡
   `renderWith(t, o, encoderFor(p))`, `expand`, `money`, `addQRCode` (inline, com
   os bytes do golden), `escpos` (`init/line/align/bold/size/feed/cut/bytes`).
7. **Fila**: `enqueue`, `claimJob`, `process`, `finishJob`, `jobStatus`,
   `processDueJobs`, `retryDelay`, `retryWorker`, `recoverInterruptedJobs`,
   `lockPrinter`, `validatePrintRequest`, `profileConfigured`.
8. **Transporte**: `sendTCPContext`, `queryDLEEOTContext`, `probePrinterStatus`,
   `applyStatusBits`.
9. **HTTP**: `authorize`, `withCORS`, `allowedOrigins`, `builtinOrigins`,
   `writeJSON`, `writeError`, e os handlers `health`, `print`, `listJobs`,
   `retry`, `printerStatus`, `listTemplates`, `discoverPrinters`.
10. **Boot**: `runDaemon(ctx) error` + `main()` com `runAsWindowsService`.

Verificação: `go build ./...` e `go vet ./...` verdes.

### Fase 3 — Religar e endurecer o que já existe

1. **Auto-update** (ADR-15): verificação antes de aplicar, assinatura, URL em
   config, nome de serviço correto, `StatusCode` checado, `CurrentVersion` por
   `-ldflags`.
2. **Monitor**: `statusMonitor()` nunca é chamado no boot. Ligar, com o
   desbloqueio automático (`unblockPrinterJobs`) quando a impressora sai de um
   estado bloqueante.
3. **Cloud worker**: `startCloudWorker` nunca é chamado. Ligar, respeitando
   `validateCloudConfig` (HTTPS obrigatório exceto localhost).
4. **Printer discovery**: expor a rota.
5. **Service log**: `resolveConfigPath`/`mustAbs` passam a existir, então
   `setupServiceLog` resolve.

### Fase 4 — Remover o que não entrou

- `spooler.go` (BoltDB) — ADR-02. `PrintJob`/`Spooler`/`NewSpooler`/`NewTransport`
  saem; `main.go` chama `runDaemon`.
- `template_manager.go` — ADR-13.
- `gemini-code-*.go` — artefatos de colagem.
- `updater.go`: reescrito (ADR-15), não apagado.
- `printer/asdasda.md` (0 bytes) e `printer/mock_server.go`: confirmar se
  pertencem à lineage B.

### Fase 5 — Fechar o contrato e a documentação

1. **Goldens**: `testdata/golden/courier-default.bin` está **desatualizado**.
   `c7eb2e1` adicionou o bloco `notes` a `templates/courier-default.json` sem
   regenerar o `.bin` (delta medido: 49 bytes = `ESC E 01` + `OBSERVAÇÕES\n` +
   `ESC E 00` + `sem cebola, capricha no gelo\n`). Regenerar com
   `UPDATE_GOLDEN=1` e rodar também `frontend/src-tauri/tests/golden.rs` — o
   renderer Go e o Rust têm que continuar byte-idênticos.
2. `go test ./...`, `go test -race ./...`, `go vet ./...` verdes.
3. `README.md`, `MANIFEST.txt`, `docs/CUPS_LINUX.md`, `docs/WEB_AUTOMATIC_PRINT.md`
   reescritos contra o código real. Hoje descrevem um daemon com SQLite +
   `api_token` + `/api/*` + claim/recovery que o código **não** implementa — e
   `docs/Revisão…md:395` admite que `go test` não pôde ser rodado.
4. `config.example.json` coerente com `Config` (inclui `status_monitor`, que
   `monitor.go` lê e o exemplo não tem).

---

## 3. Riscos e decisões em aberto

| # | Ponto | Impacto |
|---|---|---|
| R1 | `claimJob` — 1º retorno não é observável nos testes (`_`). Escolhi `attempts int`; `claimedAt time.Time` ou `printerID string` também compilam. | Baixo. `int` é o que `process` precisa para decidir `retry_waiting` × `failed`. |
| R2 | Valores de `maxItemName` / `maxItemNotes` / `maxAddons` não são fixados por teste (só `+1`). | Baixo. Escolher `maxItemName=200`, `maxItemNotes=500`, `maxAddons=12`. |
| R3 | `ProcessQueue` legado vs `retryWorker`: o worker novo precisa respeitar `next_attempt_at` e `blocked_printer`. | Médio — é onde a concorrência acontece; `-race` obrigatório. |
| R4 | `MaxOpenConns(1)` + polling de nuvem + worker + monitor na mesma instância. Serialização é o que o código commenta e respeita; um pool maior mudaria a necessidade de `reportMu`. | Médio. Não aumentar sem revisar `cloud.go:288-311`. |
| R5 | `frontend/src-tauri` tem renderer Rust próprio que precisa aplicar a mesma conversão de code page e sanitização. Os goldens do Rust cobrem só o render lógico UTF-8. | Alto para acento em produção. O Rust é caminho do app desktop; o Go é o caminho do daemon. |
| R6 | CUPS e Windows Print Spooler não expõem DLE EOT ⇒ `status_supported=false` e sem detecção de fim de papel. O `blocked_printer` não funciona nesses transportes. | Alto para UX de papel. Documentar; não inferir. |
| R7 | Backfill de `reported_status` roda em toda `migrate`. Guardado por `IS NULL` é o que evita reenviar histórico, mas uma tabela grande faz o boot ficar lento. | Baixo no volume de uma estação. |
| R8 | Templates em disco são sobrescritos por `id` sem registro de versão no banco além de `template_version`. Um job reenfileirado após o cliente trocar o template renderiza com bytes diferentes. | Médio. `payload_hash` não cobre o template. Decisão adiada: congelar bytes no job ou versionar. |

---

## 4. Fontes

- `git show a4817e1:printer/daemon/main.go` — lastro da linhagem A (1008 linhas)
- `printer/daemon/{cloud.go,monitor.go,transport*.go,service_windows.go}` — linhagem C
- `printer/daemon/*_test.go` — contrato de comportamento (7 arquivos, 68 testes)
- `frontend/src-tauri/src/printing/escpos.rs` + `tests/golden.rs` — paridade Go↔Rust
- `backend/src/integrations/printer/printer.client.ts` — contrato do backend
- `frontend/src/entities/printer/` — contrato do app web
- `printer/docs/Revisão do daemon de impressão.md` — revisão anterior (linha 1
  declara que antecede transports/token/API-v1)
- `printer/README.md` + `MANIFEST.txt` — descrição pretendida, hoje divergente
- `comversa-gemini.md` — rascunho de origem; decisões ADR-02, 12, 13, 14 e 15
  rejeitadas explicitamente
