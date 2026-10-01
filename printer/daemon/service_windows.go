//go:build windows

package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
)

const (
	windowsServiceName = "PDVPrinterDaemon"
	maxServiceLogBytes = 5 << 20
)

// windowsService adapta runDaemon ao protocolo do Service Control Manager.
//
// O SCM espera que o processo chame StartServiceCtrlDispatcher (svc.Run) e
// reporte StartPending → Running em poucos segundos. Um executável de console
// comum não faz isso: o `sc start` falha com o erro 1053 e o processo é
// encerrado, embora o mesmo .exe funcione rodando no terminal.
type windowsService struct {
	run func(context.Context) error
}

func (s *windowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case err := <-done:
			// O daemon terminou sozinho (porta ocupada, config inválido...).
			// Sai com código de erro para o SCM aplicar a ação de recuperação.
			if err != nil {
				log.Printf("daemon encerrou com erro: %v", err)
				return true, 1
			}
			return false, 0
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(15 * time.Second):
					log.Printf("shutdown excedeu 15s; encerrando mesmo assim")
				}
				return false, 0
			}
		}
	}
}

// runAsWindowsService devolve true quando o processo foi iniciado pelo SCM e
// já rodou (e terminou) como serviço. Fora do SCM devolve false e o main segue
// como processo de console.
func runAsWindowsService(run func(context.Context) error) bool {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false
	}
	setupServiceLog()
	if err := svc.Run(windowsServiceName, &windowsService{run: run}); err != nil {
		log.Printf("serviço do Windows: %v", err)
	}
	return true
}

// Um serviço não tem console: sem arquivo, todo log.Printf se perde e o
// técnico só vê "o serviço parou". O log fica ao lado do config.json
// (%ProgramData%\PDV Printer\daemon.log), com rotação simples por tamanho.
func setupServiceLog() {
	dir := filepath.Dir(mustAbs(resolveConfigPath(os.Args[1:])))
	if err := os.MkdirAll(dir, 0750); err != nil {
		return
	}
	path := filepath.Join(dir, "daemon.log")
	if info, err := os.Stat(path); err == nil && info.Size() > maxServiceLogBytes {
		_ = os.Remove(path + ".old")
		_ = os.Rename(path, path+".old")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0640)
	if err != nil {
		return
	}
	log.SetOutput(file)
}
