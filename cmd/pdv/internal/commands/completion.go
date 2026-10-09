package commands

import (
	"os"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion [bash|zsh|fish|powershell]",
	Short: "Gera script de autocomplete para o shell",
	Long: `Gera o script de autocomplete para o shell especificado.

Para carregar os completions:

Bash:
  $ source <(pdv completion bash)
  # Para carregar automaticamente, adicione ao ~/.bashrc:
  $ echo 'source <(pdv completion bash)' >> ~/.bashrc

Zsh:
  $ source <(pdv completion zsh)
  # Para carregar automaticamente, adicione ao ~/.zshrc:
  $ echo 'source <(pdv completion zsh)' >> ~/.zshrc
  # Ou coloque o arquivo em $fpath:
  $ pdv completion zsh > ~/.zsh/completion/_pdv

Fish:
  $ pdv completion fish | source
  # Para carregar automaticamente:
  $ pdv completion fish > ~/.config/fish/completions/pdv.fish

PowerShell:
  PS> pdv completion powershell | Out-String | Invoke-Expression
`,
	ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
	Args:                  cobra.ExactValidArgs(1),
	DisableFlagsInUseLine: true,
	Run: func(cmd *cobra.Command, args []string) {
		switch args[0] {
		case "bash":
			rootCmd.GenBashCompletion(os.Stdout)
		case "zsh":
			rootCmd.GenZshCompletion(os.Stdout)
		case "fish":
			rootCmd.GenFishCompletion(os.Stdout, true)
		case "powershell":
			rootCmd.GenPowerShellCompletionWithDesc(os.Stdout)
		}
	},
}

func init() {
	rootCmd.AddCommand(completionCmd)
}
