//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// cupsTransport envia ESC/POS para uma fila CUPS usando o cliente lp.
//
// O parâmetro -o raw é obrigatório: sem ele o CUPS pode aplicar filtros de
// impressão e transformar/remover comandos ESC/POS. O nome da fila é passado
// como argumento separado para exec.CommandContext; nunca é montado em shell.
type cupsTransport struct {
	printerName string
}

func newPlatformTransport(profile PrinterProfile) (PrinterTransport, error) {
	kind := strings.ToLower(strings.TrimSpace(profile.Transport))
	if kind != "cups" && kind != "cups_raw" && kind != "ipp" {
		return nil, fmt.Errorf("backend não disponível nesta plataforma: %s", profile.Transport)
	}
	if strings.TrimSpace(profile.PrinterName) == "" {
		return nil, errors.New("printer_name não configurado para CUPS")
	}
	return cupsTransport{printerName: strings.TrimSpace(profile.PrinterName)}, nil
}

func (t cupsTransport) Description() string { return "cups/raw" }

func (t cupsTransport) Send(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("documento ESC/POS vazio")
	}
	if strings.TrimSpace(t.printerName) == "" {
		return errors.New("fila CUPS vazia")
	}

	// `lp -d fila -o raw -` lê o documento pelo stdin e deixa o CUPS
	// encaminhar os bytes sem filtro. Não usamos shell para evitar expansão de
	// argumentos ou injeção pelo nome da fila.
	cmd := exec.CommandContext(ctx, "lp", "-d", t.printerName, "-o", "raw", "-")
	cmd.Stdin = bytes.NewReader(data)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("enviar ESC/POS para fila CUPS %q: %s", t.printerName, message)
	}
	return nil
}

// CUPS/IPP normalmente não expõe os sensores ESC/POS DLE EOT ao processo que
// usa a fila. O endpoint de status existente deve reportar status_supported=false
// em vez de interpretar ausência de resposta como falta de papel.
func (t cupsTransport) Query(context.Context, byte) (byte, error) {
	return 0, errors.New("DLE EOT não é exposto por CUPS")
}

// discoverPlatformPrinters lista as filas CUPS instaladas. O comando lpstat é
// parte do cliente CUPS e não executa impressão nem altera a configuração.
func discoverPlatformPrinters() ([]DiscoveredPrinter, error) {
	cmd := exec.Command("lpstat", "-p")
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			message := strings.TrimSpace(string(exitErr.Stderr))
			if message != "" {
				return nil, fmt.Errorf("listar filas CUPS: %s", message)
			}
		}
		return nil, fmt.Errorf("executar lpstat -p: %w", err)
	}
	return parseLPStatPrinters(string(output)), nil
}

// parseLPStatPrinters é separado do processo externo para ser testável em
// qualquer sistema operacional. Exemplos aceitos:
//
//	printer Elgin_MP4200 is idle. enabled since ...
//	printer Loja Caixa is printing ...
func parseLPStatPrinters(output string) []DiscoveredPrinter {
	var printers []DiscoveredPrinter
	seen := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "printer ") {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, "printer "))
		idx := strings.Index(rest, " is ")
		if idx <= 0 {
			continue
		}
		name := strings.TrimSpace(rest[:idx])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		printers = append(printers, DiscoveredPrinter{
			Name:      name,
			Transport: "cups",
		})
	}
	return printers
}
