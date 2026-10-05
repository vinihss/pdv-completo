package main

// Auto-update do daemon (ADR-15).
//
// A regra que este arquivo existe para garantir: **nada toca no executável em
// uso antes de o artefato ter sido verificado por inteiro.** A versão anterior
// baixava o binário direto para o selfupdate.Apply e só comparava o SHA256
// depois — o Apply consome o stream e substitui o executável antes do digest
// ser conferido, então um checksum divergente deixava a máquina rodando o
// binário não verificado. A ordem aqui é: manifesto → decisão → download para
// arquivo temporário → SHA256 → assinatura → Apply → restart.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"aead.dev/minisign"
	"github.com/minio/selfupdate"
)

// CurrentVersion é a versão do binário de entrega, injetada em tempo de link:
//
//	go build -ldflags "-X main.CurrentVersion=v1.4.2" ./...
//
// É `var` e não `const` por causa disso: com `const` o valor ficaria congelado
// em 1.0.0 e o daemon nunca enxergaria a própria versão nova, o que faria o
// update reaplicar o mesmo artefato para sempre. O `v` do ldflags é tolerado
// por normalizeVersion, porque a documentação de entrega escreve `v1.4.2` e o
// manifesto costuma trazer `1.4.2`.
var CurrentVersion = "1.0.0"

const (
	// O manifesto é um JSON de poucas linhas. Estourar 64 KiB significa que a
	// URL não serve um manifesto (proxy de captive portal, página de login,
	// index.html de 404) e ler isso sem teto despejaria lixo na memória do
	// daemon.
	maxManifestBytes = 64 << 10

	// Teto do binário. Um daemon de impressão tem alguns MB; 100 MiB é folga
	// para um build com símbolos e é o que impede um endpoint hostil (ou um
	// interceptor) de encher o disco da estação. O selfupdate lê o artefato
	// inteiro para a memória de qualquer jeito, então o limite também é o
	// teto de RAM do passo de verificação.
	maxBinaryBytes = 100 << 20

	// O manifesto é um GET pequeno: 15 s cobrem link ruim e acho que é o
	// suficiente para não segurar o worker de atualização.
	manifestTimeout = 15 * time.Second

	// O download não cabe em 15 s em link lento (100 MiB a 500 kB/s já leva
	// 3 minutos), e um timeout curto aqui seria um update que falha sozinho
	// justamente na loja com internet ruim — que é onde o update importa.
	downloadTimeout = 5 * time.Minute

	// Intervalo padrão quando o config não diz nada. Diário: atualização de
	// daemon é evento raro, e a loja não quer tráfego do PDV por hora.
	defaultCheckIntervalHours = 24
)

// updateWindowsService é o nome com que o serviço é registrado no SCM
// (scripts/install-windows.ps1 e service_windows.go). A constante de
// service_windows.go vive num arquivo com //go:build windows, então não pode
// ser referenciada aqui; o teste TestRestartCommandBateComOsInstaladores
// reconcilia as duas cópias lendo os arquivos-fonte, porque foi exatamente uma
// divergência de nome que deixou o restart nunca funcionando.
const updateWindowsService = "PDVPrinterDaemon"

// linuxUnitName é a unidade que scripts/install-linux.sh escreve em
// /etc/systemd/system. O código antigo usava "pdv-daemon", que não existe:
// divergência corrigida aqui e fixada por teste.
const linuxUnitName = "pdv-printer.service"

// envUpdateURL e envMinisignKey são o fallback por ambiente, para o técnico
// conseguir ligar o update numa instalação sem mexer no config.json (e para
// container, onde o config é montado por mounted).
const (
	envUpdateURL   = "PDV_UPDATE_URL"
	envMinisignKey = "PDV_UPDATE_MINISIGN_KEY"
)

// UpdateConfig é o bloco "update" do config.json. Vive em updater.go e não em
// types.go porque a linha que o liga a Config é uma adição de uma linha em
// types.go (fora do escopo desta reescrita) — ver UpdateConfigFrom.
//
// MinisignPublicKey é a âncora de confiança. Vazio significa "o operador não
// configurou assinatura", e aí o update por SHA256 segue com aviso alto; com
// chave, a assinatura passa a ser obrigatória (ver verifyArtifact).
type UpdateConfig struct {
	Enabled            bool   `json:"enabled"`
	URL                string `json:"url"`
	CheckIntervalHours int    `json:"check_interval_hours"`
	MinisignPublicKey  string `json:"minisign_public_key"`
}

// UpdateManifest é o latest.json publicado pelo backend. Os dois campos
// minisign são opcionais no arquivo (o publicador pode não ter par de chaves),
// mas obrigatórios na prática quando o operador configurou uma chave.
type UpdateManifest struct {
	Version         string `json:"version"`
	URLWindowsAMD64 string `json:"url_windows_amd64"`
	URLLinuxAMD64   string `json:"url_linux_amd64"`
	SHA256          string `json:"sha256"`
	// MinisignPublicKey é informativa: identifica o par que assinou. A
	// verificação NUNCA usa esta chave, e sim a da config local — uma chave que
	// chega pelo mesmo canal do binário que ela assinaria não prova nada.
	MinisignPublicKey string `json:"minisign_public_key"`
	// MinisignSignature é o arquivo .minisig em base64, o mesmo que o
	// publicador produz com `minisign -Sm arquivo.bin`.
	MinisignSignature string `json:"minisign_signature"`
}

// UpdateConfigFrom extrai o bloco "update" das bytes do config.json.
//
// Ponte temporária: enquanto Config não tiver o campo `Update`, o
// json.Unmarshal de loadConfig descarta o bloco e a única forma de ele chegar
// aqui é relendo as bytes do arquivo. Quando esta linha entrar em Config:
//
//	Update UpdateConfig `json:"update"`
//
// esta função pode ser apagada e o server.go passa a chamar
// CheckAndApplyUpdate(ctx, cfg.Update) direto.
func UpdateConfigFrom(content []byte) (UpdateConfig, error) {
	var wrapper struct {
		Update UpdateConfig `json:"update"`
	}
	if err := json.Unmarshal(content, &wrapper); err != nil {
		return UpdateConfig{}, fmt.Errorf("bloco update inválido: %w", err)
	}
	return wrapper.Update, nil
}

// withFallbacks aplica env e defaults. Feito aqui e não no unmarshal para que
// a mesma normalização valha para as duas portas de entrada (config.json e
// chamada direta do server.go).
func (c UpdateConfig) withFallbacks() UpdateConfig {
	if strings.TrimSpace(c.URL) == "" {
		c.URL = strings.TrimSpace(os.Getenv(envUpdateURL))
	}
	if strings.TrimSpace(c.MinisignPublicKey) == "" {
		c.MinisignPublicKey = strings.TrimSpace(os.Getenv(envMinisignKey))
	}
	if c.CheckIntervalHours <= 0 {
		c.CheckIntervalHours = defaultCheckIntervalHours
	}
	return c
}

// signatureRequired é a decisão (c) do ADR: chave configurada é a garantia
// real. Sem chave, o operador não tem como assinar, então abortar tornaria o
// update impossível em instalação legítima — mas aí o caminho sem assinatura
// tem de gritar no log, porque é o estado em que o SHA256 é a única defesa.
func (c UpdateConfig) signatureRequired() bool {
	return strings.TrimSpace(c.MinisignPublicKey) != ""
}

// updateDecision é o resultado de decideUpdate: pura, sem rede e sem disco, o
// que a torna testável sem servidor nenhum.
type updateDecision struct {
	// Skip é true quando o manifesto é da versão que já está rodando.
	Skip bool
	// URL é o artefato da plataforma atual.
	URL string
	// From é a versão publicada, para o log.
	From string
	// SignatureRequired espelha cfg.signatureRequired().
	SignatureRequired bool
}

// decideUpdate valida o manifesto e escolhe o artefato. Só falha por manifesto
// malformado ou plataforma sem artefato — nunca por rede.
func decideUpdate(cfg UpdateConfig, m UpdateManifest, currentVersion, goos string) (updateDecision, error) {
	if strings.TrimSpace(m.Version) == "" {
		return updateDecision{}, errors.New("manifesto sem versão: nada a comparar com a versão atual")
	}
	// Sem hash não há integridade nenhuma: o binário seria aplicado cegamente.
	// Falhar aqui evita gastar banda com um artefato que não pode ser conferido.
	if strings.TrimSpace(m.SHA256) == "" {
		return updateDecision{}, errors.New("manifesto sem sha256: update abortado")
	}
	digest, err := hex.DecodeString(m.SHA256)
	if err != nil {
		return updateDecision{}, fmt.Errorf("manifesto traz sha256 inválido (%q): %w", m.SHA256, err)
	}
	if len(digest) != 32 {
		return updateDecision{}, fmt.Errorf("sha256 do manifesto tem %d bytes, quero 32", len(digest))
	}

	if normalizeVersion(m.Version) == normalizeVersion(currentVersion) {
		return updateDecision{Skip: true, From: m.Version}, nil
	}

	url, err := selectArtifactURL(m, goos)
	if err != nil {
		return updateDecision{}, err
	}
	return updateDecision{
		URL:               url,
		From:              m.Version,
		SignatureRequired: cfg.signatureRequired(),
	}, nil
}

// selectArtifactURL devolve o artefato da plataforma. O manifesto só traz
// amd64 porque é o que a loja usa; campo vazio para a plataforma atual é erro
// explícito, não um update pulado em silêncio.
func selectArtifactURL(m UpdateManifest, goos string) (string, error) {
	var url string
	switch goos {
	case "windows":
		url = strings.TrimSpace(m.URLWindowsAMD64)
	case "linux":
		url = strings.TrimSpace(m.URLLinuxAMD64)
	default:
		return "", fmt.Errorf("plataforma %s sem auto-update: o daemon só publica artefato para windows e linux", goos)
	}
	if url == "" {
		return "", fmt.Errorf("manifesto da versão %s não traz artefato para %s", m.Version, goos)
	}
	return url, nil
}

// normalizeVersion tolera o "v" do ldflags e o do manifesto. Sem isso, um
// build de entrega com -X main.CurrentVersion=v1.4.2 contra um manifesto
// "1.4.2" reaplicaria o mesmo artefato em toda checagem.
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if len(v) > 1 && (v[0] == 'v' || v[0] == 'V') {
		return v[1:]
	}
	return v
}

// parseUpdateManifest lê o manifesto com teto de tamanho. Corpo maior que
// maxManifestBytes é erro: é o limite que impede que uma resposta que não é
// manifesto (HTML de login, HTML de 404) vire erro de JSON confuso ou
// alocação grande sem fim.
func parseUpdateManifest(r io.Reader) (UpdateManifest, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxManifestBytes+1))
	if err != nil {
		return UpdateManifest{}, fmt.Errorf("ler manifesto: %w", err)
	}
	if len(body) > maxManifestBytes {
		return UpdateManifest{}, fmt.Errorf("manifesto maior que %d bytes: a URL provavelmente não serve um manifesto", maxManifestBytes)
	}
	var m UpdateManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return UpdateManifest{}, fmt.Errorf("manifesto inválido: %w", err)
	}
	return m, nil
}

// verifyResult é o que a verificação provou sobre o arquivo temporário. Serve
// para o log e para os testes: SignatureChecked=false com Warning preenchido é
// o caminho sem assinatura, o único estado aceito sem chave configurada.
type verifyResult struct {
	Checksum         string
	SignatureChecked bool
	Warning          string
}

// verifyArtifact é o coração do ADR-15: confere o MESMO arquivo que vai ser
// aplicado, do SHA256 à assinatura, antes de qualquer escrita no executável.
//
// A ordem interna é deliberada: hash primeiro (barato, e pega truncamento ou
// download corrompido), assinatura depois — a assinatura cobre o binário
// inteiro, então um digest errado já invalidaria a conferência.
func verifyArtifact(path string, m UpdateManifest, cfg UpdateConfig) (verifyResult, error) {
	var result verifyResult

	digest, err := fileSHA256(path)
	if err != nil {
		return result, fmt.Errorf("ler artefato baixado: %w", err)
	}
	result.Checksum = digest
	// EqualFold porque o publicador pode emitir maiúscula e a comparação
	// textual é o que o operador lê no log.
	if !strings.EqualFold(digest, strings.TrimSpace(m.SHA256)) {
		return result, fmt.Errorf("checksum SHA256 diverge: manifesto %s, arquivo %s (update abortado, executável atual intacto)", m.SHA256, digest)
	}

	signature := strings.TrimSpace(m.MinisignSignature)
	if signature == "" {
		if cfg.signatureRequired() {
			// A chave configurada é a garantia prometida ao operador; um
			// manifesto sem assinatura nesse estado significa publicador
			// errado ou canal trocado. Seguir aqui trocaria o binário de uma
			// estação por um artefato que ninguém assinou.
			return result, errors.New("minisign_public_key configurada mas o manifesto não traz minisign_signature (update abortado, executável atual intacto)")
		}
		result.Warning = "AVISO DE SEGURANÇA: update será aplicado sem verificação de assinatura (nenhuma minisign_public_key configurada). " +
			"Quem controla o canal de distribuição controla o binário; o SHA256 acima só protege contra corrupção. " +
			"Configure " + envMinisignKey + " ou update.minisign_public_key para exigir assinatura."
		return result, nil
	}

	if err := verifyMinisignFile(path, cfg.MinisignPublicKey, signature); err != nil {
		return result, fmt.Errorf("assinatura minisign inválida: %w (update abortado, executável atual intacto)", err)
	}
	result.SignatureChecked = true
	return result, nil
}

// fileSHA256 digere o arquivo em blocos. O artefato tem dezenas de MB e o
// daemon divide a mesma máquina com a fila de impressão e o monitor: ler tudo
// para a memória duas vezes (aqui e no selfupdate) define o pico.
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// verifyMinisignFile confere a assinatura sobre o arquivo. A chave vem SEMPRE
// da configuração local, nunca do manifesto: uma chave que chega pelo mesmo
// canal do binário que ela assinaria não prova nada — é o canal se
// autenticando para si mesmo, que é exatamente o defeito que a assinatura
// minisign veio para fechar.
func verifyMinisignFile(path, publicKey, signatureB64 string) error {
	var pub minisign.PublicKey
	if err := pub.UnmarshalText([]byte(strings.TrimSpace(publicKey))); err != nil {
		return fmt.Errorf("minisign_public_key da config inválida: %w", err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureB64))
	if err != nil {
		return fmt.Errorf("minisign_signature não é base64: %w", err)
	}
	var sig minisign.Signature
	if err := sig.UnmarshalText(raw); err != nil {
		return fmt.Errorf("minisign_signature não é um .minisig válido: %w", err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// Verify (e não NewReader(...).Verify) de propósito: o Reader só aceita
	// assinatura pré-calculada (HashEdDSA, que é o que `minisign -S` produz
	// para arquivo grande), enquanto Verify cobre EdDSA e HashEdDSA. O custo é
	// manter o artefato em memória — o mesmo custo que o selfupdate já paga na
	// hora de aplicar.
	if !minisign.Verify(pub, payload, raw) {
		return errors.New("assinatura não confere com a chave configurada")
	}
	return nil
}

// updater é a dependência injetável da orquestração. Existe para que o teste
// rode o fluxo inteiro (servidor HTTP local, diretório temporário próprio,
// executável-alvo falso) sem encostar no binário do `go test` nem no serviço
// da máquina.
type updater struct {
	cfg    UpdateConfig
	client *http.Client
	goos   string
	// current é CurrentVersion em produção e um valor controlado no teste.
	current string
	// targetPath é o executável a substituir. Vazio deixa o selfupdate
	// resolver o próprio executável.
	targetPath string
	tempDir    string
	apply      func(io.Reader, selfupdate.Options) error
	restart    func() error
}

func newUpdater(cfg UpdateConfig) *updater {
	target, err := os.Executable()
	if err != nil {
		// Sem path explícito o selfupdate volta a resolver o executável, que é
		// o mesmo arquivo — só se perde a chance de logar o caminho.
		target = ""
	}
	return &updater{
		cfg:        cfg.withFallbacks(),
		client:     &http.Client{Timeout: downloadTimeout},
		goos:       runtime.GOOS,
		current:    CurrentVersion,
		targetPath: target,
		apply:      selfupdate.Apply,
		restart:    RestartDaemon,
	}
}

// CheckAndApplyUpdate verifica e aplica a atualização, se houver.
//
// A assinatura mudou em relação à versão anterior (que era
// `CheckAndApplyUpdate()` sem argumento e lia a URL de uma constante
// placeholder): a config chega por parâmetro, porque enquanto Config não tiver
// o campo `Update` não há como o bloco "update" do config.json chegar aqui — e
// função que lê arquivo por dentro não é testável sem disco.
//
// Chamada esperada, no server.go:
//
//	upd, err := UpdateConfigFrom(contentDoConfig) // até Config.Update existir
//	if err == nil && upd.Enabled {
//	    go func() {
//	        ticker := time.NewTicker(time.Duration(upd.withFallbacks().CheckIntervalHours) * time.Hour)
//	        defer ticker.Stop()
//	        for {
//	            select {
//	            case <-ctx.Done():
//	                return
//	            case <-ticker.C:
//	                CheckAndApplyUpdate(ctx, upd)
//	            }
//	        }
//	    }()
//	}
func CheckAndApplyUpdate(ctx context.Context, cfg UpdateConfig) error {
	return newUpdater(cfg).run(ctx)
}

func (u *updater) run(ctx context.Context) error {
	cfg := u.cfg
	if !cfg.Enabled {
		return nil
	}
	if strings.TrimSpace(cfg.URL) == "" {
		// A URL placeholder hardcoded saiu de propósito: um domínio embutido
		// no binário, que ninguém auditou, é um canal de atualização esperando
		// para ser apontado para lá. Sem URL configurada, não há update.
		return fmt.Errorf("update habilitado sem URL: configure update.url no config.json ou %s", envUpdateURL)
	}

	// Passo 1 — manifesto.
	manifest, err := u.fetchManifest(ctx, cfg.URL)
	if err != nil {
		return fmt.Errorf("falha ao verificar atualizações: %w", err)
	}

	// Passo 2 — já está na versão?
	decision, err := decideUpdate(cfg, manifest, u.current, u.goos)
	if err != nil {
		return err
	}
	if decision.Skip {
		slog.Debug("Daemon já está na versão mais recente", "version", normalizeVersion(u.current))
		return nil
	}
	if !decision.SignatureRequired && strings.TrimSpace(manifest.MinisignPublicKey) != "" {
		// O publicador assina, esta estação não tem a chave. O mais provável
		// é rotação de chave que o técnico não acompanhou, então o aviso sai
		// antes do download (se o download falhar, o operador precisa saber
		// mesmo assim que o caminho de update daqui não tem assinatura).
		slog.Warn("o manifesto traz minisign_public_key mas esta estação não tem chave configurada; o update será aplicado sem verificação de assinatura",
			"env", envMinisignKey, "current", u.current, "target", decision.From)
	}
	slog.Info("Nova versão encontrada. Iniciando download...", "current", u.current, "target_version", decision.From)

	// Passos 3 e 4 — artefato da plataforma, baixado para arquivo temporário.
	//
	// ===== GARANTIA DO ADR-15 =====
	// Daqui até o selfupdate.Apply, NADA toca no executável em uso. O
	// download vai para arquivo temporário, o hash e a assinatura são
	// conferidos sobre esse arquivo, e o defer remove o temporário em
	// qualquer retorno — inclusive no de falha. Se o hash divergir ou a
	// assinatura não conferir, o daemon continua rodando o binário atual,
	// intacto, e o arquivo não verificado nunca chega ao disco do
	// executável. u.apply é a ÚNICA chamada que escreve no executável.
	tmp, err := u.downloadToTemp(ctx, decision.URL)
	if err != nil {
		return fmt.Errorf("falha no download: %w", err)
	}
	defer os.Remove(tmp)

	// Passos 5 e 6 — verificação sobre o MESMO arquivo que será aplicado.
	result, err := verifyArtifact(tmp, manifest, cfg)
	if err != nil {
		return err
	}
	if result.Warning != "" {
		slog.Warn(result.Warning, "version", decision.From, "sha256", result.Checksum)
	}
	slog.Info("Artefato verificado", "sha256", result.Checksum, "assinatura_conferida", result.SignatureChecked)

	// Passo 7 — só agora o executável é substituído.
	if err := u.applyVerified(tmp, manifest, result, cfg); err != nil {
		return err
	}

	// Passos 8 e 9 — o 8 é o RollbackError dentro de applyVerified. Falha no
	// Apply já retornou; o que sobra é o reinício, que precisa acontecer para
	// a versão nova entrar em vigor.
	slog.Info("Atualização aplicada. Reiniciando serviço...")
	return u.restart()
}

// applyVerified é o passo 7. Além do Apply, ele reconecta as duas verificações
// dentro do próprio selfupdate (Checksum e Verifier), que são uma segunda
// barreira independente: se algo nesta função falhasse, o PrepareAndCheckBinary
// ainda se recusaria a criar o .target.new.
func (u *updater) applyVerified(tmp string, m UpdateManifest, result verifyResult, cfg UpdateConfig) error {
	opts := selfupdate.Options{TargetPath: u.targetPath}

	if digest, err := hex.DecodeString(strings.TrimSpace(m.SHA256)); err == nil {
		opts.Checksum = digest
	}
	if result.SignatureChecked {
		// O selfupdate v0.6.0 não tem construtor de Verifier em memória: só
		// LoadFromURL e LoadFromFile. Como a assinatura já está em memória
		// (veio no manifesto), ela é escrita em .minisig ao lado do
		// temporário e apagada no mesmo defer do artefato. Custa um arquivo
		// extra e compra a verificação do lado da biblioteca, independente da
		// nossa.
		sigPath := tmp + ".minisig"
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m.MinisignSignature))
		if err != nil {
			return fmt.Errorf("minisign_signature não é base64: %w (executável atual intacto)", err)
		}
		if err := os.WriteFile(sigPath, raw, 0600); err != nil {
			return fmt.Errorf("gravar .minisig temporário: %w (executável atual intacto)", err)
		}
		defer os.Remove(sigPath)
		verifier := selfupdate.NewVerifier()
		if err := verifier.LoadFromFile(sigPath, strings.TrimSpace(cfg.MinisignPublicKey)); err != nil {
			return fmt.Errorf("selfupdate não aceitou a assinatura: %w (executável atual intacto)", err)
		}
		opts.Verifier = verifier
	}

	file, err := os.Open(tmp)
	if err != nil {
		return fmt.Errorf("abrir artefato verificado: %w (executável atual intacto)", err)
	}
	defer file.Close()

	if err := u.apply(file, opts); err != nil {
		// RollbackError não-nil significa que o selfupdate não conseguiu
		// devolver o executável antigo para o lugar: o disco ficou sem binário
		// e isso é recovery manual, não retry.
		if rerr := selfupdate.RollbackError(err); rerr != nil {
			slog.Error("ERRO FATAL: rollback do update falhou; o executável precisa ser reposto à mão", "error", rerr)
			return fmt.Errorf("aplicar atualização: %w (rollback também falhou: %v)", err, rerr)
		}
		return fmt.Errorf("erro ao aplicar atualização: %w (executável preservado)", err)
	}
	return nil
}

// fetchManifest é o passo 1. StatusCode é conferido antes do corpo: sem isso,
// um 404 de proxy virava "manifesto inválido: invalid character '<'" e o
// operador caçava um bug de JSON que não existe.
func (u *updater) fetchManifest(ctx context.Context, url string) (UpdateManifest, error) {
	ctx, cancel := context.WithTimeout(ctx, manifestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return UpdateManifest{}, err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return UpdateManifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return UpdateManifest{}, fmt.Errorf("GET %s devolveu %s%s", url, resp.Status, bodyHint(resp.Body))
	}
	return parseUpdateManifest(resp.Body)
}

// bodyHint devolve um trecho curto do corpo de erro, que é a diferença entre
// "404 Not Found" e "404 Not Found: <html>…exige autenticação…</html>". As
// quebras de linha são achatadas porque o destino é o log.
func bodyHint(body io.Reader) string {
	snippet, err := io.ReadAll(io.LimitReader(body, 200))
	if err != nil {
		return ""
	}
	text := bytes.TrimSpace(snippet)
	if len(text) == 0 {
		return ""
	}
	return ": " + strings.Join(strings.Fields(string(text)), " ")
}

// downloadToTemp é o passo 4. Grava em arquivo temporário — nunca no
// executável — e barra estouros de tamanho pelo LimitReader, que devolve
// maxBinaryBytes+1 quando o corpo é maior e é por isso que a comparação é
// com > e não com >=.
func (u *updater) downloadToTemp(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s devolveu %s%s", url, resp.Status, bodyHint(resp.Body))
	}

	file, err := os.CreateTemp(u.tempDir, "pdv-daemon-update-*.exe")
	if err != nil {
		return "", err
	}
	path := file.Name()
	written, err := io.Copy(file, io.LimitReader(resp.Body, maxBinaryBytes+1))
	if err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	if written > maxBinaryBytes {
		os.Remove(path)
		return "", fmt.Errorf("binário maior que %d bytes", maxBinaryBytes)
	}
	return path, nil
}

// RestartDaemon dispara o reinício do serviço.
//
// Não espera o comando terminar, e isso é decisão, não descuido:
// `net stop PDVPrinterDaemon` (e `systemctl restart`) só completam depois que
// ESTE processo encerra. Se o chamador usasse Run(), ele ficaria esperando o
// stop, o stop esperaria este processo sair, e a saída dependeria do chamador
// voltar — um deadlock que no Windows estoura o timeout de 15 s do stop no SCM
// (service_windows.go) e no Linux vira um restart que o systemd cancela.
// Start() + seguir em frente deixa o SCM conduzir o desligamento normal, que
// é o caminho que o instalador já valida.
func RestartDaemon() error {
	name, args, err := restartCommand(runtime.GOOS)
	if err != nil {
		return err
	}
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("disparar reinício (%s): %w", name, err)
	}
	// Wait em goroutine só para recolher o filho: sem isso o processo fica
	// zumbi até o daemon sair, e ele não sai logo — o SCM é quem pede.
	go func() { _ = cmd.Wait() }()
	return nil
}

// restartCommand monta o comando de reinício sem executar. Separado do
// RestartDaemon para o teste fixar o nome do serviço e o da unidade sem
// reiniciar nada.
func restartCommand(goos string) (string, []string, error) {
	switch goos {
	case "windows":
		// cmd.exe com a linha inteira: o && precisa do shell, e stop/start têm
		// de ser sequenciais (start antes do stop completar falha com 1053).
		return "cmd.exe", []string{"/c", "net stop " + updateWindowsService + " && net start " + updateWindowsService}, nil
	case "linux":
		return "systemctl", []string{"restart", linuxUnitName}, nil
	default:
		// Erro explícito, e não o re-exec + os.Exit(0) antigo: sair do
		// processo de dentro de uma biblioteca derruba o drain da fila e o
		// recovery de jobs. O binário novo já está aplicado; o operador
		// reinicia quando puder.
		return "", nil, fmt.Errorf("auto-restart não implementado em %s: o binário novo já foi aplicado, reinicie o serviço manualmente", goos)
	}
}
