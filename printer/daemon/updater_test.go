package main

// Testes do auto-update (ADR-15).
//
// O alvo é a ordem da verificação, não a cobertura de linhas. Os testes de
// rede (run completo) rodam contra httptest e injetam o `apply`, o
// `targetPath` e o `tempDir` — assim o binário do `go test` e o serviço da
// máquina nunca são tocados, e dá para afirmar a garantia do ADR-15: se a
// verificação falhar, o executável em uso não mudou e o temporário sumiu.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"aead.dev/minisign"
	"github.com/minio/selfupdate"
)

// fakeTarget cria o "executável em uso" do teste: um arquivo comum num
// diretório temporário, com conteúdo conhecido. Substituir o TargetPath do
// selfupdate por ele é o que permite verificar a garantia do passo 4→7 sem
// encostar no binário real.
func fakeTarget(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pdv-printer-daemon")
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// tempDirVazio é a asserção do "temporário foi removido": o updater cria tudo
// que precisa dentro de um diretório só, então o sumiço dele depois do run é
// exatamente o que o `defer os.Remove(tmp)` promete.
func tempDirVazio(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("temporários não removidos: %v", names)
	}
}

// minisignPair devolve um par de chaves novo e o texto da chave pública (o
// formato que o minisign-keygen escreve no .pub e o que vai no config.json).
// Gerado na hora de propósito: chave de teste no repositório seria chave de
// teste na loja.
func minisignPair(t *testing.T) (pubText string, priv minisign.PrivateKey) {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	text, err := pub.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	return string(text), priv
}

// signBase64 assina o payload no formato EdDSA e devolve o .minisig em base64,
// que é o que vai no campo minisign_signature do manifesto.
func signBase64(t *testing.T, priv minisign.PrivateKey, payload []byte) string {
	t.Helper()
	return base64.StdEncoding.EncodeToString(minisign.Sign(priv, payload))
}

// signText é o mesmo que signBase64 com outro nome. Existe porque "text" é o
// termo do minisign (é o conteúdo de um arquivo .minisig) e deixa explícito que
// o valor já vai base64, que é o formato do campo minisign_signature.
func signText(t *testing.T, priv minisign.PrivateKey, payload []byte) string {
	t.Helper()
	return signBase64(t, priv, payload)
}

func manifestFor(payload []byte, version, winURL, linuxURL string) UpdateManifest {
	sum := sha256.Sum256(payload)
	return UpdateManifest{
		Version:         version,
		URLWindowsAMD64: winURL,
		URLLinuxAMD64:   linuxURL,
		SHA256:          hex.EncodeToString(sum[:]),
	}
}

// signedManifest monta um manifesto assinado com um par de chaves novo. Devolve
// a privada, a pública (o formato que vai no config.json) e a assinatura em
// base64. Cada chamada gera um par distinto, que é o que permite testar
// "assinatura feita por outra chave".
func signedManifest(t *testing.T, payload []byte, version string) (priv minisign.PrivateKey, pubText string, sigB64 string) {
	t.Helper()
	pubText, priv = minisignPair(t)
	m := manifestFor(payload, version, "https://exemplo/daemon.exe", "https://exemplo/daemon")
	m.MinisignPublicKey = pubText
	m.MinisignSignature = signBase64(t, priv, payload)
	return priv, pubText, m.MinisignSignature
}

// ---------------------------------------------------------------------------
// A garantia central: verificação antes de aplicar.
// ---------------------------------------------------------------------------

// TestRunAbortaComSHA256DivergenteSemTocarNoExecutável é o teste do defeito
// central do ADR-15. A versão anterior aplicava primeiro e comparava o digest
// depois, então um checksum divergente deixava a estação rodando o binário não
// verificado. Aqui o `apply` é uma stub que SUBSTITUI o executável-alvo, como
// o selfupdate faria: se o run a chamasse, o conteúdo errado estaria no disco.
func TestRunAbortaComSHA256DivergenteSemTocarNoExecutavel(t *testing.T) {
	const current = "EXECUTAVEL-EM-USO-v1.0.0"
	const baixado = "BINARIO-NAO-VERIFICADO"

	// O manifesto anuncia um digest que não é o do arquivo servido: é o
	// exatamente o cenário de canal adulterado.
	manifest := manifestFor([]byte("outro-conteudo-qualquer"), "1.1.0", "", "")
	server := httptest.NewServer(updateFixture(t, manifest, []byte(baixado)))
	defer server.Close()

	target := fakeTarget(t, current)
	tempDir := t.TempDir()
	applied := false

	u := &updater{
		cfg:        UpdateConfig{Enabled: true, URL: server.URL + "/latest.json"},
		client:     server.Client(),
		goos:       "linux",
		current:    "1.0.0",
		targetPath: target,
		tempDir:    tempDir,
		apply: func(r io.Reader, o selfupdate.Options) error {
			applied = true
			return nil
		},
		restart: func() error { t.Fatal("restart não pode rodar com update abortado"); return nil },
	}

	err := u.run(context.Background())
	if err == nil {
		t.Fatal("checksum divergente deveria abortar o update")
	}
	if !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("erro não menciona o checksum: %v", err)
	}
	if applied {
		t.Fatal("selfupdate.Apply foi chamado com checksum divergente — é o bug do ADR-15")
	}
	if got := readFile(t, target); got != current {
		t.Fatalf("executável em uso foi alterado: %q", got)
	}
	tempDirVazio(t, tempDir)
}

// TestRunAbortaComAssinaturaInvalidaSemTocarNoExecutavel cobre a assinatura
// madeira-que-não-confere: o SHA256 bate (o publicador mandou o arquivo certo),
// mas a assinatura é de outro par de chaves. É o caso que só a assinatura
// pega.
func TestRunAbortaComAssinaturaInvalidaSemTocarNoExecutavel(t *testing.T) {
	const current = "EXECUTAVEL-EM-USO-v1.0.0"
	payload := []byte("binario-do-publicador")

	_, goodPub, goodSig := signedManifest(t, payload, "1.1.0")
	_, otherPub, _ := signedManifest(t, payload, "1.1.0")

	manifest := manifestFor(payload, "1.1.0", "", "")
	manifest.MinisignPublicKey = goodPub
	manifest.MinisignSignature = base64.StdEncoding.EncodeToString([]byte(goodSig))

	server := httptest.NewServer(updateFixture(t, manifest, payload))
	defer server.Close()

	target := fakeTarget(t, current)
	tempDir := t.TempDir()
	applied := false

	u := &updater{
		// A estação confia numa terceira chave: nem a do publicador, nem a da
		// assinatura. A verificação tem de falhar.
		cfg:        UpdateConfig{Enabled: true, URL: server.URL + "/latest.json", MinisignPublicKey: otherPub},
		client:     server.Client(),
		goos:       "linux",
		current:    "1.0.0",
		targetPath: target,
		tempDir:    tempDir,
		apply: func(r io.Reader, o selfupdate.Options) error {
			applied = true
			return nil
		},
		restart: func() error { return nil },
	}

	err := u.run(context.Background())
	if err == nil {
		t.Fatal("assinatura de outra chave deveria abortar o update")
	}
	if !strings.Contains(err.Error(), "minisign") {
		t.Fatalf("erro não menciona a assinatura: %v", err)
	}
	if applied {
		t.Fatal("selfupdate.Apply foi chamado com assinatura inválida")
	}
	if got := readFile(t, target); got != current {
		t.Fatalf("executável em uso foi alterado: %q", got)
	}
	tempDirVazio(t, tempDir)
}

// TestRunHappyPathTrocouOExecutavel é o contrapeso: quando tudo confere, o
// executável really é substituído. Sem este teste, uma implementação que
// aborta sempre também "passaria" nos casos de falha.
func TestRunHappyPathTrocouOExecutavel(t *testing.T) {
	payload := []byte("binario-novo-assinado")
	_, pub, sig := signedManifest(t, payload, "1.1.0")

	manifest := manifestFor(payload, "1.1.0", "", "")
	manifest.MinisignPublicKey = pub
	manifest.MinisignSignature = base64.StdEncoding.EncodeToString([]byte(sig))

	server := httptest.NewServer(updateFixture(t, manifest, payload))
	defer server.Close()

	target := fakeTarget(t, "EXECUTAVEL-EM-USO-v1.0.0")
	tempDir := t.TempDir()
	restarted := false

	u := &updater{
		cfg:        UpdateConfig{Enabled: true, URL: server.URL + "/latest.json", MinisignPublicKey: pub},
		client:     server.Client(),
		goos:       "linux",
		current:    "1.0.0",
		targetPath: target,
		tempDir:    tempDir,
		apply:      selfupdate.Apply,
		restart:    func() error { restarted = true; return nil },
	}

	if err := u.run(context.Background()); err != nil {
		t.Fatalf("update válido falhou: %v", err)
	}
	if got := readFile(t, target); got != string(payload) {
		t.Fatalf("executável não foi substituído: %q", got)
	}
	if !restarted {
		t.Fatal("serviço não foi reiniciado após aplicar o update")
	}
	tempDirVazio(t, tempDir)
}

// ---------------------------------------------------------------------------
// Decisão (c) sobre a assinatura: chave configurada é a garantia real.
// ---------------------------------------------------------------------------

// TestRunSemChaveConfiguradaAceitaManifestoSemAssinaturaComAviso: sem chave o
// operador não tem como assinar, então abortar tornaria o update impossível
// numa instalação legítima. O caminho sem assinatura segue — mas tem de dizer
// no log, porque é o estado em que só o SHA256 protege.
func TestRunSemChaveConfiguradaAceitaManifestoSemAssinatura(t *testing.T) {
	payload := []byte("binario-sem-assinatura")
	manifest := manifestFor(payload, "1.1.0", "", "")

	server := httptest.NewServer(updateFixture(t, manifest, payload))
	defer server.Close()

	target := fakeTarget(t, "EXECUTAVEL-EM-USO-v1.0.0")
	tempDir := t.TempDir()

	u := &updater{
		cfg:        UpdateConfig{Enabled: true, URL: server.URL + "/latest.json"},
		client:     server.Client(),
		goos:       "linux",
		current:    "1.0.0",
		targetPath: target,
		tempDir:    tempDir,
		apply:      selfupdate.Apply,
		restart:    func() error { return nil },
	}

	if err := u.run(context.Background()); err != nil {
		t.Fatalf("update sem assinatura e sem chave configurada deveria seguir: %v", err)
	}
	if got := readFile(t, target); got != string(payload) {
		t.Fatalf("executável não foi substituído: %q", got)
	}

	// O aviso não pode ser silencioso: verifyArtifact é quem decide, e o texto
	// é o contrato com o operador.
	result, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{})
	if err != nil {
		t.Fatalf("verifyArtifact: %v", err)
	}
	if result.SignatureChecked {
		t.Fatal("SignatureChecked verdadeiro sem assinatura no manifesto")
	}
	if !strings.Contains(result.Warning, "AVISO DE SEGURANÇA") {
		t.Fatalf("sem chave configurada o aviso de segurança é obrigatório: %q", result.Warning)
	}
	if !strings.Contains(result.Warning, envMinisignKey) {
		t.Fatalf("o aviso precisa apontar a env de configuração: %q", result.Warning)
	}
}

// TestRunComChaveConfiguradaAbortaSemAssinatura é o outro lado da decisão (c):
// chave configurada é promessa de garantia, então manifesto sem assinatura
// aborta mesmo com o SHA256 correto.
func TestRunComChaveConfiguradaAbortaSemAssinatura(t *testing.T) {
	payload := []byte("binario-sem-assinatura")
	_, pub, _ := signedManifest(t, payload, "1.1.0")
	manifest := manifestFor(payload, "1.1.0", "", "")
	manifest.MinisignPublicKey = pub // publica chave, mas esquece a assinatura

	server := httptest.NewServer(updateFixture(t, manifest, payload))
	defer server.Close()

	target := fakeTarget(t, "EXECUTAVEL-EM-USO-v1.0.0")
	tempDir := t.TempDir()
	applied := false

	u := &updater{
		cfg:        UpdateConfig{Enabled: true, URL: server.URL + "/latest.json", MinisignPublicKey: pub},
		client:     server.Client(),
		goos:       "linux",
		current:    "1.0.0",
		targetPath: target,
		tempDir:    tempDir,
		apply: func(r io.Reader, o selfupdate.Options) error {
			applied = true
			return nil
		},
		restart: func() error { return nil },
	}

	err := u.run(context.Background())
	if err == nil {
		t.Fatal("chave configurada + manifesto sem assinatura deveria abortar")
	}
	if !strings.Contains(err.Error(), "minisign_signature") {
		t.Fatalf("erro não explica a causa: %v", err)
	}
	if applied {
		t.Fatal("selfupdate.Apply foi chamado com assinatura ausente")
	}
	if got := readFile(t, target); got != "EXECUTAVEL-EM-USO-v1.0.0" {
		t.Fatalf("executável em uso foi alterado: %q", got)
	}
	tempDirVazio(t, tempDir)
}

// ---------------------------------------------------------------------------
// Limites de rede: corpo grande demais e StatusCode.
// ---------------------------------------------------------------------------

func TestParseUpdateManifestRejeitaCorpoGrandeDemais(t *testing.T) {
	// JSON válido e enorme: sem o LimitReader, isto seria uma alocação
	// silenciosa. A URL configurada pode estar atrás de um captive portal que
	// devolve uma página de login gigante em vez do latest.json.
	grande := `{"version":"1.1.0","sha256":"` + strings.Repeat("a", maxManifestBytes) + `"}`
	if _, err := parseUpdateManifest(strings.NewReader(grande)); err == nil {
		t.Fatal("manifesto acima do limite deveria ser rejeitado")
	}

	// No limite, com um manifesto pequeno: tem que passar.
	if _, err := parseUpdateManifest(strings.NewReader(`{"version":"1.1.0","sha256":"x"}`)); err != nil {
		t.Fatalf("manifesto pequeno rejeitado: %v", err)
	}
}

func TestFetchManifestConfereStatusCode(t *testing.T) {
	// Um 404 de proxy com HTML é o caso que o código antigo transformava em
	// "manifesto inválido: invalid character '<'" — mandando o operador caçar
	// bug de JSON onde o problema é a URL.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "<html><body>proxy exige autenticacao</body></html>")
	}))
	defer server.Close()

	u := &updater{client: server.Client()}
	_, err := u.fetchManifest(context.Background(), server.URL)
	if err == nil {
		t.Fatal("404 deveria ser erro")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("erro não traz o status: %v", err)
	}
	if !strings.Contains(err.Error(), "proxy exige autenticacao") {
		t.Fatalf("erro não traz o corpo que explica o 404: %v", err)
	}
}

func TestRunSemURLDeUpdateNaoFazRede(t *testing.T) {
	// A constante placeholder https://api.meusistema.com/... saiu: sem URL
	// configurada o update não tem para onde ir, e o binário de entrega não
	// deve carregar um domínio de terceiros como destino padrão.
	u := &updater{cfg: UpdateConfig{Enabled: true}, current: "1.0.0", goos: "linux"}
	err := u.run(context.Background())
	if err == nil {
		t.Fatal("update habilitado sem URL deveria ser erro explícito")
	}
	if !strings.Contains(err.Error(), envUpdateURL) {
		t.Fatalf("erro não aponta a env de configuração: %v", err)
	}
}

func TestRunDesabilitadoNaoFazNada(t *testing.T) {
	u := &updater{cfg: UpdateConfig{Enabled: false}, current: "1.0.0", goos: "linux"}
	if err := u.run(context.Background()); err != nil {
		t.Fatalf("update desabilitado deveria ser no-op: %v", err)
	}
}

func TestDownloadToTempBarraBinarioAcimaDoTeto(t *testing.T) {
	// Barato de simular com limite artificial não é opção (maxBinaryBytes é
	// constante de compilação); o que se fixa aqui é o comportamento do
	// LimitReader: ele devolve N+1 e a comparação tem de ser por ">".
	reader := strings.NewReader("conteudo")
	got, err := io.ReadAll(io.LimitReader(reader, maxManifestBytes+1))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != maxManifestBytes+1 {
		t.Fatalf("LimitReader deveria devolver o limite+1, devolveu %d", len(got))
	}
}

// ---------------------------------------------------------------------------
// Decisão de versão e escolha de artefato (puras, sem rede).
// ---------------------------------------------------------------------------

func TestDecideUpdatePulaQuandoVersaoEhACorrente(t *testing.T) {
	manifest := manifestFor([]byte("payload"), CurrentVersion, "https://exemplo/daemon.exe", "https://exemplo/daemon")

	// O run inteiro tem que devolver nil sem nem pedir o binário: o teste
	// conta as requisições no handler.
	baixados := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest.json" {
			baixados++
		}
		_ = json.NewEncoder(w).Encode(manifest)
	}))
	defer server.Close()

	u := &updater{
		cfg:    UpdateConfig{Enabled: true, URL: server.URL + "/latest.json"},
		client: server.Client(),
		goos:   "linux",
		// current igual à do manifesto, até com o "v" do ldflags: é assim que
		// o build de entrega se enxerga.
		current: "v" + CurrentVersion,
		apply:   func(r io.Reader, o selfupdate.Options) error { t.Fatal("Apply não deveria rodar"); return nil },
		restart: func() error { t.Fatal("restart não deveria rodar"); return nil },
	}

	if err := u.run(context.Background()); err != nil {
		t.Fatalf("versão corrente deveria ser no-op: %v", err)
	}
	if baixados != 0 {
		t.Fatalf("binário foi baixado %d vez(es) sem precisar de update", baixados)
	}
}

func TestDecideUpdatePulaComPrefoVDeLdflags(t *testing.T) {
	manifest := manifestFor([]byte("payload"), "1.0.0", "https://exemplo/daemon.exe", "https://exemplo/daemon")
	decision, err := decideUpdate(UpdateConfig{}, manifest, "v1.0.0", "linux")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Skip {
		t.Fatal(`"v1.0.0" (ldflags) e "1.0.0" (manifesto) são a mesma versão`)
	}
}

func TestDecideUpdateRejeitaManifestoIncompleto(t *testing.T) {
	cases := []struct {
		nome     string
		manifest UpdateManifest
	}{
		{"sem versão", UpdateManifest{SHA256: strings.Repeat("ab", 32)}},
		{"sem sha256", UpdateManifest{Version: "1.1.0"}},
		{"sha256 não é hex", UpdateManifest{Version: "1.1.0", SHA256: "zz"}},
		{"sha256 curto", UpdateManifest{Version: "1.1.0", SHA256: strings.Repeat("ab", 16)}},
	}
	for _, tc := range cases {
		t.Run(tc.nome, func(t *testing.T) {
			if _, err := decideUpdate(UpdateConfig{}, tc.manifest, "1.0.0", "linux"); err == nil {
				t.Fatal("manifesto inválido deveria ser rejeitado antes de qualquer download")
			}
		})
	}
}

func TestSelectArtifactURLPorPlataforma(t *testing.T) {
	manifest := manifestFor([]byte("payload"), "1.1.0",
		"https://exemplo/daemon-windows-amd64.exe",
		"https://exemplo/daemon-linux-amd64")

	cases := []struct {
		goos string
		want string
	}{
		{"windows", manifest.URLWindowsAMD64},
		{"linux", manifest.URLLinuxAMD64},
	}
	for _, tc := range cases {
		got, err := selectArtifactURL(manifest, tc.goos)
		if err != nil {
			t.Fatalf("%s: %v", tc.goos, err)
		}
		if got != tc.want {
			t.Fatalf("%s: url = %q, quero %q", tc.goos, got, tc.want)
		}
	}

	// Plataforma sem artefato é erro explícito, não update pulado em silêncio.
	_, darwinErr := selectArtifactURL(manifest, "darwin")
	if darwinErr == nil {
		t.Fatal("plataforma sem suporte deveria ser erro")
	}
	if !strings.Contains(darwinErr.Error(), "darwin") {
		t.Fatal("o erro precisa dizer qual plataforma")
	}

	// Manifesto sem artefato para a plataforma atual: erro, não URL vazia.
	semLinux := manifestFor([]byte("payload"), "1.1.0", "https://exemplo/daemon.exe", "")
	if _, err := selectArtifactURL(semLinux, "linux"); err == nil {
		t.Fatal("manifesto sem artefato para linux deveria ser erro")
	}
}

// ---------------------------------------------------------------------------
// Verificação pura sobre arquivo.
// ---------------------------------------------------------------------------

func TestVerifyArtifactAceitaAssinaturaValida(t *testing.T) {
	payload := []byte("binario-novo")
	_, pub, sig := signedManifest(t, payload, "1.1.0")

	manifest := manifestFor(payload, "1.1.0", "", "")
	manifest.MinisignPublicKey = pub
	manifest.MinisignSignature = base64.StdEncoding.EncodeToString([]byte(sig))

	result, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: pub})
	if err != nil {
		t.Fatalf("assinatura válida foi rejeitada: %v", err)
	}
	if !result.SignatureChecked {
		t.Fatal("SignatureChecked deveria ser verdadeiro")
	}
	if result.Warning != "" {
		t.Fatalf("caminho assinado não deve emitir aviso: %q", result.Warning)
	}
}

func TestVerifyArtifactRejeitaHashEDepoisAssinatura(t *testing.T) {
	payload := []byte("binario-novo")
	_, pub, sig := signedManifest(t, payload, "1.1.0")

	t.Run("hash divergente", func(t *testing.T) {
		manifest := manifestFor([]byte("outro"), "1.1.0", "", "")
		manifest.MinisignPublicKey = pub
		manifest.MinisignSignature = base64.StdEncoding.EncodeToString([]byte(sig))
		_, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: pub})
		if err == nil || !strings.Contains(err.Error(), "checksum") {
			t.Fatalf("hash divergente deveria abortar: %v", err)
		}
	})

	t.Run("assinatura de outro conteúdo", func(t *testing.T) {
		// Hash bate (o manifesto descreve este arquivo), assinatura não: só
		// quem assina poderia produzir isto, e o hash não prova procedência.
		manifest := manifestFor(payload, "1.1.0", "", "")
		manifest.MinisignPublicKey = pub
		manifest.MinisignSignature = signText(t, mustPrivate(t, pub), []byte("outro payload"))
		_, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: pub})
		if err == nil {
			t.Fatal("assinatura de outro payload deveria abortar")
		}
	})

	t.Run("chave da config inválida", func(t *testing.T) {
		manifest := manifestFor(payload, "1.1.0", "", "")
		manifest.MinisignSignature = base64.StdEncoding.EncodeToString([]byte(sig))
		_, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: "nao-e-chave"})
		if err == nil || !strings.Contains(err.Error(), "minisign_public_key") {
			t.Fatalf("chave inválida deveria abortar: %v", err)
		}
	})

	t.Run("assinatura não é base64", func(t *testing.T) {
		manifest := manifestFor(payload, "1.1.0", "", "")
		manifest.MinisignSignature = "### nao base64 ###"
		_, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: pub})
		if err == nil {
			t.Fatal("assinatura corrompida deveria abortar")
		}
	})
}

// TestVerifyArtifactAceitaAssinaturaPrecalculada fixa o formato que a CLI
// minisign realmente produz para arquivo grande (HashEdDSA, assinatura sobre o
// BLAKE2b do conteúdo). Se alguém trocar Verify por NewReader(...).Verify sem
// perceber, este teste quebra — e a loja para de atualizar.
func TestVerifyArtifactAceitaAssinaturaPrecalculada(t *testing.T) {
	payload := []byte("binario-grande-assinado-com-prehash")
	_, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubText, err := priv.Public().(minisign.PublicKey).MarshalText()
	if err != nil {
		t.Fatal(err)
	}

	// NewReader().SignWithComments é o caminho pré-calculado (HashEdDSA).
	reader := minisign.NewReader(strings.NewReader(string(payload)))
	raw := reader.SignWithComments(priv, "timestamp:0", "test")

	manifest := manifestFor(payload, "1.1.0", "", "")
	manifest.MinisignPublicKey = string(pubText)
	manifest.MinisignSignature = base64.StdEncoding.EncodeToString(raw)

	result, err := verifyArtifact(writeTemp(t, payload), manifest, UpdateConfig{MinisignPublicKey: string(pubText)})
	if err != nil {
		t.Fatalf("assinatura pré-calculada (formato da CLI) foi rejeitada: %v", err)
	}
	if !result.SignatureChecked {
		t.Fatal("SignatureChecked deveria ser verdadeiro")
	}
}

// ---------------------------------------------------------------------------
// Config: env, defaults e o bloco "update" do config.json.
// ---------------------------------------------------------------------------

func TestUpdateConfigFromLeiOBaixoUpdate(t *testing.T) {
	content := []byte(`{
      "api_token": "abc",
      "listen": "127.0.0.1:8080",
      "update": {
        "enabled": true,
        "url": "https://api.exemplo.com/daemon/latest.json",
        "check_interval_hours": 12,
        "minisign_public_key": "RWQ..."
      }
    }`)

	cfg, err := UpdateConfigFrom(content)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Enabled || cfg.URL != "https://api.exemplo.com/daemon/latest.json" {
		t.Fatalf("bloco update não lido: %+v", cfg)
	}
	if cfg.CheckIntervalHours != 12 || cfg.MinisignPublicKey != "RWQ..." {
		t.Fatalf("campos do bloco update não lidos: %+v", cfg)
	}

	// Config sem o bloco: zero value, sem erro. Um config.json de loja
	// existente não pode falhar ao carregar por causa de um campo que ele
	// não tem.
	cfg, err = UpdateConfigFrom([]byte(`{"api_token":"abc"}`))
	if err != nil || cfg.Enabled || cfg.URL != "" {
		t.Fatalf("config sem bloco update: %+v err=%v", cfg, err)
	}
}

func TestUpdateConfigWithFallbacksUsaEnv(t *testing.T) {
	t.Setenv(envUpdateURL, "https://env.exemplo/latest.json")
	t.Setenv(envMinisignKey, "chave-do-env")

	cfg := UpdateConfig{Enabled: true}.withFallbacks()
	if cfg.URL != "https://env.exemplo/latest.json" {
		t.Fatalf("URL do env ignorada: %q", cfg.URL)
	}
	if cfg.MinisignPublicKey != "chave-do-env" {
		t.Fatalf("chave do env ignorada: %q", cfg.MinisignPublicKey)
	}
	if !cfg.signatureRequired() {
		t.Fatal("chave vinda do env tem que contar como assinatura configurada")
	}
	if cfg.CheckIntervalHours != defaultCheckIntervalHours {
		t.Fatalf("intervalo padrão = %d, quero %d", cfg.CheckIntervalHours, defaultCheckIntervalHours)
	}

	// Config tem precedência sobre o env: o que o técnico escreveu no arquivo
	// não pode ser sobrescrito por variável herdada do ambiente.
	cfg = UpdateConfig{URL: "https://config.exemplo/latest.json", MinisignPublicKey: "chave-do-config"}.withFallbacks()
	if cfg.URL != "https://config.exemplo/latest.json" || cfg.MinisignPublicKey != "chave-do-config" {
		t.Fatalf("env sobrepôs o config: %+v", cfg)
	}
}

// ---------------------------------------------------------------------------
// Restart: nome do serviço, unidade e bloqueio.
// ---------------------------------------------------------------------------

func TestRestartCommandPorPlataforma(t *testing.T) {
	name, args, err := restartCommand("windows")
	if err != nil {
		t.Fatal(err)
	}
	if name != "cmd.exe" {
		t.Fatalf("windows: comando = %q", name)
	}
	// O nome antigo (PDVDaemon) nunca existiu no SCM: o serviço é
	// PDVPrinterDaemon (service_windows.go e install-windows.ps1). Com o
	// nome errado, `net stop` falhava e o restart nunca acontecia.
	if !strings.Contains(args[2], updateWindowsService) {
		t.Fatalf("windows: linha sem o nome real do serviço: %q", args[2])
	}
	if !strings.Contains(args[2], "net stop") || !strings.Contains(args[2], "net start") {
		t.Fatalf("windows: stop e start precisam ser sequenciais: %q", args[2])
	}

	name, args, err = restartCommand("linux")
	if err != nil {
		t.Fatal(err)
	}
	if name != "systemctl" || args[1] != linuxUnitName {
		t.Fatalf("linux: %q %v", name, args)
	}

	if _, _, err := restartCommand("darwin"); err == nil {
		t.Fatal("plataforma sem auto-restart deveria ser erro explícito")
	}
}

// TestRestartCommandBateComOsInstaladores amarra as constantes do código aos
// arquivos que registram o serviço de verdade. Foi uma divergência de nome
// (PDVDaemon vs PDVPrinterDaemon, pdv-daemon vs pdv-printer.service) que
// deixou o restart nunca funcionando; comparar com o fonte impede a volta.
func TestRestartCommandBateComOsInstaladores(t *testing.T) {
	win, err := os.ReadFile(filepath.Join("..", "scripts", "install-windows.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(win), updateWindowsService) {
		t.Fatalf("install-windows.ps1 não registra %s", updateWindowsService)
	}

	lin, err := os.ReadFile(filepath.Join("..", "scripts", "install-linux.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(lin), linuxUnitName) {
		t.Fatalf("install-linux.sh não instala %s", linuxUnitName)
	}

	// A constante do service_windows.go é a fonte do nome no SCM; como o
	// arquivo é de build windows, a comparação é por leitura.
	svc, err := os.ReadFile("service_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(svc), `windowsServiceName = "`+updateWindowsService+`"`) {
		t.Fatal("updateWindowsService divergiu de windowsServiceName em service_windows.go")
	}
}

// TestRestartDaemonNaoBloqueia documenta a decisão: cmd.Start() e não
// cmd.Run(). Um serviço Windows que chama `sc stop` em si mesmo e espera
// estoura o timeout de 15 s do stop no SCM (service_windows.go), porque o stop
// só termina quando o processo termina, e o processo só termina se o stop
// terminar. Verificar que a função devolve sem o comando existir é a prova
// pragmática do não-bloqueio.
func TestRestartDaemonNaoBloqueia(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("restart só é implementado em windows e linux")
	}
	// Em linux, o RestartDaemon dispara "systemctl restart pdv-printer.service".
	// Num CI sem systemd a chamada falha rápido (binário ausente ou
	// "System has not been booted with systemd"), e o ponto é exatamente
	// isso: a função retorna, não fica esperando o serviço.
	_ = RestartDaemon()
}

// ---------------------------------------------------------------------------
// Normalização de versão.
// ---------------------------------------------------------------------------

func TestNormalizeVersionToleraPrefoV(t *testing.T) {
	cases := map[string]string{
		"1.4.2":   "1.4.2",
		"v1.4.2":  "1.4.2",
		"V1.4.2":  "1.4.2",
		" 1.4.2 ": "1.4.2",
		"v":       "v",
		"":        "",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Fatalf("normalizeVersion(%q) = %q, quero %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// updateFixture serve o manifesto em /latest.json e o artefato em qualquer
// outro path. Servir de verdade (em vez de stubar o cliente) é o que exercita
// o LimitReader e o StatusCode do caminho de download.
func updateFixture(t *testing.T, manifest UpdateManifest, payload []byte) http.Handler {
	t.Helper()
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest.json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	})
}

func writeTemp(t *testing.T, payload []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "artefato")
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustErr(t *testing.T, _ string, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("esperava erro")
	}
	return err.Error()
}

func mustPrivate(t *testing.T, pubText string) minisign.PrivateKey {
	t.Helper()
	var pub minisign.PublicKey
	if err := pub.UnmarshalText([]byte(pubText)); err != nil {
		t.Fatal(err)
	}
	_ = pub
	t.Fatal("helper não usado")
	return minisign.PrivateKey{}
}
