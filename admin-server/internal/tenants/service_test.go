package tenants

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

type fakeRunner struct {
	stdout string
	stderr string
	err    error

	gotDir  string
	gotName string
	gotArgs []string
}

func (f *fakeRunner) Run(_ context.Context, dir, name string, args ...string) (string, string, error) {
	f.gotDir = dir
	f.gotName = name
	f.gotArgs = args
	return f.stdout, f.stderr, f.err
}

func TestProvisionExtraiPin(t *testing.T) {
	runner := &fakeRunner{stdout: "[seed-prod] Usuário gerente \"Gerente\" criado — PIN: 9876\n"}
	svc := NewServiceWithRunner(runner, "deploy-backend-1", time.Second)

	pin, err := svc.Provision(context.Background(), "umami", "Umami Sushi")
	if err != nil {
		t.Fatalf("Provision falhou: %v", err)
	}
	if pin != "9876" {
		t.Errorf("pin = %q, quer 9876", pin)
	}
	want := []string{"exec", "deploy-backend-1", "node", "dist/infra/db/provision-tenant.js", "umami", "Umami Sushi"}
	if runner.gotName != "docker" || !reflect.DeepEqual(runner.gotArgs, want) {
		t.Errorf("comando = %s %v", runner.gotName, runner.gotArgs)
	}
}

func TestProvisionSemPinNaoFalha(t *testing.T) {
	runner := &fakeRunner{stdout: "[provision] tenant pronto (SEED=0)\n"}
	svc := NewServiceWithRunner(runner, "c", time.Second)

	pin, err := svc.Provision(context.Background(), "umami", "Umami Sushi")
	if err != nil {
		t.Fatalf("Provision falhou: %v", err)
	}
	if pin != "" {
		t.Errorf("pin = %q, quer vazio", pin)
	}
}

func TestProvisionFalhaDevolveSaida(t *testing.T) {
	runner := &fakeRunner{stderr: "erro do script", err: errors.New("exit 1")}
	svc := NewServiceWithRunner(runner, "c", time.Second)

	_, err := svc.Provision(context.Background(), "umami", "x")
	var pe *ProvisionError
	if !errors.As(err, &pe) {
		t.Fatalf("erro = %v, quer *ProvisionError", err)
	}
	if pe.Output != "erro do script" {
		t.Errorf("output = %q", pe.Output)
	}
}

func TestBackupFiltraPorTarget(t *testing.T) {
	runner := &fakeRunner{stdout: "" +
		"Backup do banco 'pdv' (container deploy-postgres-1) -> /opt/backups/pdv-1.dump\n" +
		"Backup das fotos de produto ('pdv_backend_uploads') -> /opt/backups/pdv-1-uploads.tar.gz\n" +
		"OK: 1K /opt/backups/pdv-1.dump\n"}
	svc := NewBackupServiceWithRunner(runner, "/opt/pdv/deploy", time.Second)

	casos := []struct {
		target string
		want   []string
	}{
		{"db", []string{"/opt/backups/pdv-1.dump"}},
		{"files", []string{"/opt/backups/pdv-1-uploads.tar.gz"}},
		{"all", []string{"/opt/backups/pdv-1.dump", "/opt/backups/pdv-1-uploads.tar.gz"}},
	}
	for _, c := range casos {
		t.Run(c.target, func(t *testing.T) {
			paths, err := svc.Backup(context.Background(), c.target)
			if err != nil {
				t.Fatalf("Backup falhou: %v", err)
			}
			if !reflect.DeepEqual(paths, c.want) {
				t.Errorf("paths = %v, quer %v", paths, c.want)
			}
		})
	}
	if runner.gotDir != "/opt/pdv/deploy" {
		t.Errorf("cwd = %q, quer /opt/pdv/deploy", runner.gotDir)
	}
}

func TestBackupNaoConfigurado(t *testing.T) {
	svc := NewBackupServiceWithRunner(&fakeRunner{}, "", time.Second)
	if _, err := svc.Backup(context.Background(), "all"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("erro = %v, quer ErrNotConfigured", err)
	}
}

func TestBackupFalhaDevolveSaida(t *testing.T) {
	runner := &fakeRunner{stderr: "pg_dump não encontrado", err: errors.New("exit 1")}
	svc := NewBackupServiceWithRunner(runner, "/opt/pdv/deploy", time.Second)

	_, err := svc.Backup(context.Background(), "all")
	var be *BackupError
	if !errors.As(err, &be) {
		t.Fatalf("erro = %v, quer *BackupError", err)
	}
	if be.Output != "pg_dump não encontrado" {
		t.Errorf("output = %q", be.Output)
	}
}
