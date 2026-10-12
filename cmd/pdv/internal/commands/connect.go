package commands

import (
	"context"
	"fmt"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/remote"
	"pdv-cli/internal/ui"
)

var (
	connectSSHHost      string
	connectSSHPort      int
	connectSSHUser      string
	connectSSHKey       string
	connectSSHDeployDir string
)

var connectCmd = &cobra.Command{
	Use:   "connect <nome> <url> <token>",
	Short: "Valida e salva um admin-server remoto em ~/.pdv/servers.json",
	Long: `Valida o admin-server (health + listagem de tenants) e salva a conexão em
~/.pdv/servers.json com chmod 0600.

Flags opcionais de SSH (habilitam o deploy via TUI):
  --host <host>        endereço do host onde o PDV roda (SSH)
  --port <porta>       porta SSH (default 22)
  --user <usuário>     usuário SSH
  --key <caminho>      chave privada SSH (default ~/.ssh/id_ed25519)
  --deploy-dir <dir>   raiz do repositório no host; o deploy roda
                       'bash <dir>/deploy/switch.sh'`,
	Args: cobra.ExactArgs(3),
	Run: func(cmd *cobra.Command, args []string) {
		name, rawURL, token := args[0], args[1], args[2]

		client := remote.New(rawURL, token)
		ctx := context.Background()

		health, err := client.Health(ctx)
		if err != nil {
			ui.Die("não foi possível alcançar %s: %v", client.BaseURL(), err)
		}
		if _, err := client.ListTenants(ctx); err != nil {
			ui.Die("token rejeitado por %s: %v", client.BaseURL(), err)
		}

		if err := config.UpsertServer(name, client.BaseURL(), token); err != nil {
			ui.Die("falha ao salvar servidor %s: %v", name, err)
		}

		if anySSHFlag() {
			if err := config.SetServerSSH(name, connectSSHHost, connectSSHPort, connectSSHUser, connectSSHKey, connectSSHDeployDir); err != nil {
				ui.Die("falha ao salvar configuração SSH do servidor %s: %v", name, err)
			}
		}

		ui.LogMsg("conectado a %s (%s) — versão %s", name, client.BaseURL(), health.Version)
	},
}

// anySSHFlag diz se pelo menos uma flag de SSH foi passada em connect.
func anySSHFlag() bool {
	return connectSSHHost != "" || connectSSHPort != 0 || connectSSHUser != "" ||
		connectSSHKey != "" || connectSSHDeployDir != ""
}

var serversCmd = &cobra.Command{
	Use:                "servers <list|remove>",
	Short:              "Gerencia os admin-servers salvos",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		ui.Die("uso: ./pdv servers <list|remove <nome>>")
	},
}

var serversListCmd = &cobra.Command{
	Use:   "list",
	Short: "Lista os admin-servers salvos (sem expor o token)",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		cfg, err := config.LoadServersConfig()
		if err != nil {
			ui.Die("falha ao ler servers.json: %v", err)
		}
		if len(cfg.Servers) == 0 {
			ui.WarnMsg("nenhum admin-server salvo (use: ./pdv connect <nome> <url> <token>)")
			return
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NOME\tURL\tSTATUS")
		for _, s := range cfg.Servers {
			url := s.URL
			if url == "" {
				url = "-"
			}
			status := s.LastStatus
			if status == "" {
				status = "-"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\n", s.Name, url, status)
		}
		w.Flush()
	},
}

var serversRemoveCmd = &cobra.Command{
	Use:   "remove <nome>",
	Short: "Remove um admin-server salvo",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		name := args[0]
		if _, err := config.GetServer(name); err != nil {
			ui.Die("admin-server não encontrado: %s", name)
		}
		if err := config.RemoveServer(name); err != nil {
			ui.Die("falha ao remover %s: %v", name, err)
		}
		ui.LogMsg("removido: %s", name)
	},
}

func init() {
	serversCmd.AddCommand(serversListCmd)
	serversCmd.AddCommand(serversRemoveCmd)

	f := connectCmd.Flags()
	f.StringVar(&connectSSHHost, "host", "", "endereço SSH do host onde o PDV roda")
	f.IntVar(&connectSSHPort, "port", 0, "porta SSH (default 22)")
	f.StringVar(&connectSSHUser, "user", "", "usuário SSH")
	f.StringVar(&connectSSHKey, "key", "", "caminho da chave privada SSH (default ~/.ssh/id_ed25519)")
	f.StringVar(&connectSSHDeployDir, "deploy-dir", "", "raiz do repositório no host (deploy roda bash <dir>/deploy/switch.sh)")
}
