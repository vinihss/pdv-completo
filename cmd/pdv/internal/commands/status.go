package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/ui"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Diagnóstico do ambiente (read-only: git, worktrees, versões, dependências locais)",
	Args: func(cmd *cobra.Command, args []string) error {
		if len(args) != 0 {
			ui.Die("uso: ./pdv status")
		}
		return nil
	},
	Run: func(cmd *cobra.Command, args []string) {
		RunStatus()
	},
}

// RunStatus executa o diagnóstico completo do ambiente em modo somente leitura.
func RunStatus() {
	ui.LogMsg("── git ──")
	gitCmd := exec.Command("git", "-C", config.RootPath, "rev-parse", "--git-dir")
	if err := gitCmd.Run(); err == nil {
		branchOut, err := exec.Command("git", "-C", config.RootPath, "branch", "--show-current").Output()
		branch := strings.TrimSpace(string(branchOut))
		if err != nil || branch == "" {
			branch = "(HEAD desanexado)"
		}
		fmt.Printf("branch: %s\n", branch)

		statusOut, _ := exec.Command("git", "-C", config.RootPath, "status", "-s").Output()
		lines := strings.Split(strings.TrimRight(string(statusOut), "\n"), "\n")
		var dirtyLines []string
		for _, line := range lines {
			if strings.TrimSpace(line) != "" {
				dirtyLines = append(dirtyLines, line)
			}
		}
		dirtyCount := len(dirtyLines)
		if dirtyCount > 0 {
			limit := 10
			if limit > dirtyCount {
				limit = dirtyCount
			}
			for i := 0; i < limit; i++ {
				fmt.Println(dirtyLines[i])
			}
			if dirtyCount > 10 {
				fmt.Printf("… e mais %d arquivo(s) alterado(s)\n", dirtyCount-10)
			}
		} else {
			fmt.Println("working tree limpa")
		}
	} else {
		ui.WarnMsg("git indisponível ou %s não é um repositório", config.RootPath)
	}

	fmt.Println()
	ui.LogMsg("── worktrees ──")
	wtCmd := exec.Command("bash", filepath.Join(config.RootPath, "scripts/dev/dev-worktree.sh"), "list")
	wtCmd.Dir = config.RootPath
	wtCmd.Stdin = os.Stdin
	wtCmd.Stdout = os.Stdout
	wtCmd.Stderr = os.Stderr
	if err := wtCmd.Run(); err != nil {
		ui.WarnMsg("não consegui listar os worktrees (scripts/dev/dev-worktree.sh list)")
	}

	fmt.Println()
	ui.LogMsg("── versões ──")
	tools := []string{"git", "node", "npm", "go", "docker"}
	for _, tool := range tools {
		if path, err := exec.LookPath(tool); err == nil && path != "" {
			var verCmd *exec.Cmd
			if tool == "go" {
				verCmd = exec.Command(tool, "version")
			} else {
				verCmd = exec.Command(tool, "--version")
			}
			out, err := verCmd.Output()
			verStr := "?"
			if err == nil {
				firstLine := strings.Split(strings.TrimSpace(string(out)), "\n")[0]
				if firstLine != "" {
					verStr = firstLine
				}
			}
			fmt.Printf("  %-6s %s\n", tool, verStr)
		} else {
			fmt.Printf("  %-6s não instalado\n", tool)
		}
	}

	fmt.Println()
	ui.LogMsg("── dependências locais ──")
	deps := []string{"backend/node_modules", "frontend/node_modules", "backend/.env"}
	for _, dep := range deps {
		fullPath := filepath.Join(config.RootPath, dep)
		if _, err := os.Stat(fullPath); err == nil {
			fmt.Printf("  %-22s ok\n", dep)
		} else {
			fmt.Printf("  %-22s AUSENTE\n", dep)
		}
	}
}
