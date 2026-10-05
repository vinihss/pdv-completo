# Sprint — Automação de build/instalação do daemon de impressão

**Sprint ID:** sprint/print-install-automation  
**Status:** Em execução  
**Responsável:** coordenador + subagentes especializados  
**Regra de ouro:** apenas `printer/daemon/` e `printer/scripts/` (nenhum outro módulo impactado).

---

## 1. Problema (por que esta sprint existe)

O daemon (`printer/daemon/`) passou por uma refatoração completa (`origin/printer-refactory`, `818d1fc`), mas **não existe um caminho de instalação repetível** para quem não tem Go:

- `install-linux.sh` exige Go para compilar (`go build`) — funciona para dev, não para técnico de campo.
- `install-windows.ps1` espera um `.exe` ao lado (ou Go), mas **não existe o script `package-daemon-windows.sh`** que o próprio `install-windows.ps1` referencia (`printer/scripts/install-windows.ps1:6` e `146`). A referência é uma armadilha (o `.exe` nunca vem com o pacote porque o pacote nunca é gerado).
- Não há modo de **teste local rápido**: para validar se o daemon imprime, o técnico precisa compilar, criar `config.json`, iniciar o serviço, enviar POST e conferir `/api/printers/status`. Nada disso está automatizado.
- O CI (`tests.yml`) só roda `test-printer-daemon`; não há gate de **build de entrega** (binário + pacote) nem de **cross-compile Windows** (verificado local, mas não no CI — o subagente confirmou que `GOOS=windows go build/vet` passa).

---

## 2. Objetivo (definição de feito — Definition of Done)

| # | Critério | Como confirmar |
|---|---|---|
| 2.1 | **Windows**: rodar `bash printer/scripts/package-daemon-windows.sh` e gerar `printer/artifacts/pdv-printer-daemon-<ver>-windows-amd64.zip` contendo `.exe`, `.sha256`, `install-windows.ps1`, `README.md`, `config.example.json`. | Arquivo existe, `.sha256` é válido, `unzip -t` passa. |
| 2.2 | **Linux**: rodar `bash printer/scripts/package-daemon-linux.sh` e gerar `printer/artifacts/pdv-printer-daemon-<ver>-linux-amd64.tar.gz` contendo binário, `install-linux.sh`, `templates/`. | Arquivo existe, `tar -tzf` passa, `install-linux.sh` não exige Go no destino. |
| 2.3 | **CI**: workflow `.github/workflows/build-daemon.yml` roda em `push` de tag/branch, produz os dois artefatos, sobe como `artifact`, não como release (release é do `deploy-on-tag.yml`). | Log do CI mostra `build-daemon` verde, artefatos listados. |
| 2.4 | **Cross-compile gate**: `GOOS=windows go build/vet` passa no CI, assim como o Linux existente. | Log do CI mostra ambos verdes. |
| 2.5 | **Modo de teste local**: `bash printer/scripts/test-local.sh` inicia daemon em porta efêmera (`:18080`), envia `POST /print` com `testdata/sample-print.json`, confirma `202 Accepted`, confere `/api/jobs`, para o daemon. Funciona sem `sudo`, sem serviço, sem editar `config.json` de produção. | Log do script termina com `TESTE OK`. |
| 2.6 | **Documentação**: `printer/docs/arquitetura-daemon.md` atualizado com seção "Instalação rápida" (um por plataforma) e referência ao sprint. | `grep -n "Instalação rápida" printer/docs/arquitetura-daemon.md` retorna linha. |

---

## 3. Backlog de tarefas (prioridade P0 → P2)

### P0 — Entregar o básico (impede qualquer instalação de campo)

- [ ] `@devops-bot` — criar `.github/workflows/build-daemon.yml`: build Linux + Windows com `go build -trimpath -ldflags='-s -w'`, `go test -race ./...` (opcional, só se verde), `go vet`, `gofmt -l; test -z`, pacote em `printer/artifacts/`.
- [ ] `@devops-bot` — criar `printer/scripts/package-daemon-windows.sh`: compilar `go build`, gerar `.sha256` (`sha256sum > .exe.sha256`), zip com `install-windows.ps1`, `README.md`, `config.example.json`, `templates/`.
- [ ] `@devops-bot` — criar `printer/scripts/package-daemon-linux.sh`: compilar, tar.gz (`tar -czf ... daemon binary install-linux.sh templates/ README.md config.example.json`).
- [ ] `@devops-bot` — adicionar gate `GOOS=windows go build/vet` ao job `test-printer-daemon` existente (já confirmado verde localmente; adiciona determinismo ao que já funciona).

### P1 — Modo de teste local (impede validação antes de instalar)

- [ ] `@devops-bot` — criar `printer/scripts/test-local.sh` + `test-local.ps1`:
  - Cria temp dir (`mktemp -d` / `New-TemporaryFile`); escreve `config.json` mínimo (listen `127.0.0.1:18080`, printer `kitchen` apontando para `127.0.0.1:9100`, token fixo `test-token`).
  - Inicia daemon (`go run ./daemon` ou `./pdv-printer-daemon`) com `PDV_PRINTER_CONFIG=<temp>/config.json`; aguarda `/health` (loop até 5s, timeout 10s).
  - Inicia mock printer (`mock_server.go`) no `:9100` (para receber bytes reais) — opcional (se mock falhar, o teste ainda passa se o daemon aceitar o job; o objetivo é testar a API, não a impressora física).
  - Envia `POST /print` com `printer/daemon/testdata/sample-print.json` (novo arquivo, ver abaixo).
  - Confirma status `202 Accepted`, confere `/api/jobs`, confirma que `queue_depth > 0` ou `status == queued`.
  - Envia `SIGTERM` (Linux) / `Stop-Process` (Windows) ao daemon; limpa temp dir (exceto log de erro, que é mantido para debug).
  - Se qualquer etapa falhar: exit 1 + mensagem indicando o passo; se passar: exit 0 + mensagem de sucesso.
- [ ] `@devops-bot` — criar `printer/daemon/testdata/sample-print.json`: payload mínimo compatível com o contrato da API (`destination`, `order` com `items`, `total_cents`, `customer`, `delivery`). Pode ser derivado do `fixture-order.json` existente (já tem `name`, `items`, `total_cents`, etc.).
- [ ] `@frontend-core` (se houver) — documentar no `printer/README.md` como rodar o modo local em 3 linhas.

### P2 — Polimento (não bloqueia entrega)

- [ ] `@devops-bot` — adicionar `.deb` via `fpm` (opcional; se não houver `fpm` no CI, documentar como passo manual) para instalação `dpkg -i`.
- [ ] `@devops-bot` — adicionar `printer/scripts/package-daemon-linux.sh --release` com assinatura `minisign` opcional (reutilizar o mecanismo do `updater.go`).
- [ ] `@general` — atualizar `printer/docs/arquitetura-daemon.md` seção "Instalação rápida" com os comandos de cada plataforma.
- [ ] `@devops-bot` — adicionar `test-local` ao `.github/workflows/tests.yml` como job separado (opcional; só se o script for confiável — pode falhar por porta em uso, então é melhor rodar apenas em PR que altere o daemon, ou como `workflow_dispatch`).

---

## 4. Decisões arquiteturais (já tomadas, não precisam ser discutidas)

| Decisão | Justificativa | Onde está documentado |
|---|---|---|
| **Binário, não Docker** | O daemon fala com impressora local (USB/serial/TCP) e precisa de acesso ao hardware; container adicionaria complexidade sem ganho. | `printer/docs/arquitetura-daemon.md` §Requisitos |
| **Windows `.exe` via `go build`, Linux via `tar.gz`** | O alvo de produção é Windows (`install-windows.ps1` + serviço SCM). Linux é secundário (CUPS + systemd). Ambos usam o mesmo `go build`. | `printer/README.md` §Build |
| **Não incluir `go` no pacote de instalação** | A instalação de campo deve ser "copie o zip, rode o script". O `install-linux.sh` ainda exige Go, mas o pacote de entrega (`tar.gz`) contém o binário pronto. | Sprint 2.1 / 2.2 |
| **Cross-compile no CI, não só local** | Já verificado que `GOOS=windows go build/vet` passa; o CI garante que futuras mudanças no `transport_windows.go` não quebram o build de entrega. | Sprint 2.4 |
| **Test local usa `127.0.0.1:18080` + mock `:9100`** | Evita conflito com produção; o mock (`mock_server.go`) já existe e é suficiente para confirmar que o daemon envia bytes; não precisa da impressora física. | Sprint 2.5 / `mock_server.go` |

---

## 5. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| `package-daemon-windows.sh` não gera `.sha256` corretamente | Baixa | Teste do CI inclui verificação do `.sha256` após `unzip`. |
| `GOOS=windows go build` falha por mudança futura no `transport_windows.go` | Média | Gate no `tests.yml` detecta imediatamente; não precisa esperar a tag. |
| Modo de teste local falha por porta ocupada (`:18080`) | Média | Script usa `lsof -i :18080` / `netstat` para detectar e tentar porta alternativa; se falhar, imprime o endereço usado para debug. |
| Operador instala `.exe` sem `install-windows.ps1` (copia manual) | Média | `README.md` atualizado com passo explícito; `.sha256` está no zip para verificação manual. |
| `mock_server.go` não reflete o protocolo ESC/POS real | Baixa | O objetivo do modo local é testar a **API** (POST /print → fila → envio → status), não a qualidade do papel. A impressora real é testada separadamente. |

---

## 6. Artefatos entregáveis desta sprint

- [x] Documento: `printer/docs/arquitetura-daemon.md` (já existe; atualizo com seção de instalação rápida)
- [x] Sprint doc: `printer/docs/sprint-install-automation.md` (esti arquivo)
- [ ] Script Linux: `printer/scripts/package-daemon-linux.sh`
- [ ] Script Windows: `printer/scripts/package-daemon-windows.sh`
- [ ] Script teste local: `printer/scripts/test-local.sh` + `test-local.ps1`
- [ ] Payload de teste: `printer/daemon/testdata/sample-print.json`
- [ ] CI: `.github/workflows/build-daemon.yml`
- [ ] Update `tests.yml`: gate `GOOS=windows`
- [ ] Update `README.md`: seção de instalação rápida

---

## 7. Definição de pronto (DoD) — quando a sprint fecha

- [ ] `bash printer/scripts/test-local.sh` termina com `TESTE OK`.  
- [ ] `bash printer/scripts/package-daemon-windows.sh` gera zip; `unzip -t` passa; `.sha256` confirma.  
- [ ] `bash printer/scripts/package-daemon-linux.sh` gera tar.gz; `tar -tzf` passa; `install-linux.sh` não exige Go no destino (verifica com `command -v go || echo "Go não necessário no destino"` no script, se já tiver binário).  
- [ ] `.github/workflows/build-daemon.yml` roda e produz artefatos.  
- [ ] `tests.yml` tem `GOOS=windows go build/vet`.  
- [ ] Nenhum arquivo fora de `printer/` foi alterado (regra do coordenador).

---

## 8. Próximos passos (após fechar esta sprint)

1. **Consolidar no `deploy-on-tag.yml`**: se o `build-daemon.yml` gerar uma tag `v*`, considerar publicar o artefato como GitHub Release (já feito pelo `release.yml` automático). O `build-daemon.yml` pode ser chamado por `workflow_call` se necessário, mas o mais simples é rodar em `push` de tag e subir como `artifact` + `release`.
2. **Documentar o modo de teste no app**: se o frontend precisar de um botão "Testar impressora", o `test-local` pode ser chamado via `invoke` do Tauri.
3. **Monitoramento**: adicionar métricas ao `monitor.go` (já existe) para expor latência de fila, taxa de sucesso por destino, etc.
