package ui

import (
	"fmt"
	"os"
)

// IsTerminal verifica se o arquivo é um terminal interativo (TTY).
func IsTerminal(f *os.File) bool {
	stat, err := f.Stat()
	if err != nil {
		return false
	}
	return (stat.Mode() & os.ModeCharDevice) != 0
}

// LogMsg imprime mensagem informativa com cor verde caso seja terminal.
func LogMsg(format string, a ...interface{}) {
	msg := fmt.Sprintf(format, a...)
	if IsTerminal(os.Stdout) {
		fmt.Printf("\033[32m%s\033[0m\n", msg)
	} else {
		fmt.Println(msg)
	}
}

// WarnMsg imprime mensagem de aviso com cor amarela no stderr.
func WarnMsg(format string, a ...interface{}) {
	msg := fmt.Sprintf(format, a...)
	if IsTerminal(os.Stderr) {
		fmt.Fprintf(os.Stderr, "\033[33m%s\033[0m\n", msg)
	} else {
		fmt.Fprintln(os.Stderr, msg)
	}
}

// Die imprime mensagem de erro em vermelho no stderr e encerra o processo com código 1.
func Die(format string, a ...interface{}) {
	msg := fmt.Sprintf(format, a...)
	if IsTerminal(os.Stderr) {
		fmt.Fprintf(os.Stderr, "\033[31m%s\033[0m\n", msg)
	} else {
		fmt.Fprintln(os.Stderr, msg)
	}
	os.Exit(1)
}
