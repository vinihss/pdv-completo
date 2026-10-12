// Package ssh fornece um cliente SSH mínimo, com autenticação por chave
// privada e verificação de host key, usado pelo deploy do PDV via TUI.
package ssh

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	xssh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Runner executa um comando remoto via SSH, entregando stdout e stderr linha a
// linha. onLine pode ser chamado concorrentemente (stdout e stderr são lidos em
// goroutines separadas), então o chamador deve garantir que ele seja seguro
// para uso concorrente.
type Runner interface {
	Run(ctx context.Context, command string, onLine func(string)) error
}

// Client é um cliente SSH autenticado por chave privada.
type Client struct {
	host    string
	port    int
	user    string
	keyPath string
}

// New cria um Client. Se port <= 0, assume a porta padrão 22.
func New(host string, port int, user, keyPath string) *Client {
	if port <= 0 {
		port = 22
	}
	return &Client{host: host, port: port, user: user, keyPath: keyPath}
}

// Run executa command no host remoto, chamando onLine para cada linha de stdout
// e stderr. Devolve o erro da sessão (incluindo o exit status), ou ctx.Err() se
// o contexto for cancelado. Quando o contexto termina, a sessão é fechada para
// que Run não fique bloqueado.
func (c *Client) Run(ctx context.Context, command string, onLine func(string)) error {
	if strings.TrimSpace(c.host) == "" {
		return errors.New("host SSH vazio")
	}
	if strings.TrimSpace(c.user) == "" {
		return errors.New("usuário SSH vazio")
	}

	hostKeyCb, err := c.hostKeyCallback()
	if err != nil {
		return err
	}
	auth, err := c.authMethods()
	if err != nil {
		return err
	}

	cfg := &xssh.ClientConfig{
		User:            c.user,
		Auth:            auth,
		HostKeyCallback: hostKeyCb,
	}

	addr := net.JoinHostPort(c.host, strconv.Itoa(c.port))

	conn, err := dial(ctx, addr, cfg)
	if err != nil {
		return err
	}
	defer conn.Close()

	sess, err := conn.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()

	stdout, err := sess.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return err
	}

	if err := sess.Start(command); err != nil {
		return err
	}

	// As goroutines de leitura precisam terminar antes de Run retornar: o
	// chamador (a TUI) fecha o canal logo depois, e uma chamada tardia a
	// onLine enviaria num canal fechado.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); streamLines(stdout, onLine) }()
	go func() { defer wg.Done(); streamLines(stderr, onLine) }()

	result := make(chan error, 1)
	go func() { result <- sess.Wait() }()

	select {
	case err := <-result:
		wg.Wait()
		return exitStatus(err)
	case <-ctx.Done():
		// Fecha a sessão para destravar o Wait e libera a goroutine.
		sess.Close()
		<-result
		wg.Wait()
		return ctx.Err()
	}
}

// dial abre a conexão TCP e faz o handshake SSH, respeitando o contexto e um
// timeout de discagem.
func dial(ctx context.Context, addr string, cfg *xssh.ClientConfig) (*xssh.Client, error) {
	d := net.Dialer{Timeout: 15 * time.Second}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	c, chans, reqs, err := xssh.NewClientConn(raw, addr, cfg)
	if err != nil {
		raw.Close()
		return nil, err
	}
	return xssh.NewClient(c, chans, reqs), nil
}

// authMethods monta a autenticação por chave. Sem keyPath explícito, tenta
// ~/.ssh/id_ed25519 e depois ~/.ssh/id_rsa (a primeira que existir).
func (c *Client) authMethods() ([]xssh.AuthMethod, error) {
	keyPath := c.keyPath
	if keyPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("não foi possível descobrir o HOME para localizar a chave SSH: %w", err)
		}
		for _, rel := range []string{".ssh/id_ed25519", ".ssh/id_rsa"} {
			candidate := filepath.Join(home, rel)
			if fileExists(candidate) {
				keyPath = candidate
				break
			}
		}
	}
	if keyPath == "" {
		return nil, errors.New("nenhuma chave SSH configurada: passe --key ou crie ~/.ssh/id_ed25519 (ou ~/.ssh/id_rsa)")
	}

	data, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("falha ao ler a chave SSH %s: %w", keyPath, err)
	}
	signer, err := xssh.ParsePrivateKey(data)
	if err != nil {
		return nil, fmt.Errorf("falha ao interpretar a chave SSH %s: %w", keyPath, err)
	}
	return []xssh.AuthMethod{xssh.PublicKeys(signer)}, nil
}

// hostKeyCallback monta a verificação de host key a partir de known_hosts.
// Sem known_hosts, recusa a conexão — nunca usa InsecureIgnoreHostKey.
func (c *Client) hostKeyCallback() (xssh.HostKeyCallback, error) {
	var files []string
	if home, err := os.UserHomeDir(); err == nil {
		userKnownHosts := filepath.Join(home, ".ssh", "known_hosts")
		if fileExists(userKnownHosts) {
			files = append(files, userKnownHosts)
		}
	}
	if fileExists("/etc/ssh/ssh_known_hosts") {
		files = append(files, "/etc/ssh/ssh_known_hosts")
	}
	if len(files) == 0 {
		return nil, errors.New("nenhum known_hosts encontrado: a verificação de host key exige ~/.ssh/known_hosts ou /etc/ssh/ssh_known_hosts")
	}

	cb, err := knownhosts.New(files...)
	if err != nil {
		return nil, fmt.Errorf("falha ao carregar known_hosts: %w", err)
	}

	return func(hostname string, remote net.Addr, key xssh.PublicKey) error {
		if err := cb(hostname, remote, key); err != nil {
			return fmt.Errorf(
				"verificação de host key falhou para %s: %v\n    se o host ainda não foi cadastrado, adicione com:\n    ssh-keyscan %s >> ~/.ssh/known_hosts",
				c.host, err, c.host,
			)
		}
		return nil
	}, nil
}

// streamLines lê linhas de um reader e as entrega a onLine.
func streamLines(r io.Reader, onLine func(string)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		onLine(sc.Text())
	}
}

// exitStatus normaliza o erro de sessão incluindo o exit status, quando houver.
func exitStatus(err error) error {
	if err == nil {
		return nil
	}
	var exitErr *xssh.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Errorf("comando SSH falhou com exit status %d: %w", exitErr.ExitStatus(), err)
	}
	return err
}

// fileExists diz se path existe e não é um diretório.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
