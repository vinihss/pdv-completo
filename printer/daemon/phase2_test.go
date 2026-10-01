//go:build !windows

package main

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
)

func TestWindowsSpoolerProfileUsesPrinterName(t *testing.T) {
	if !profileConfigured(PrinterProfile{Transport: "windows_spooler", PrinterName: "Elgin MP-4200"}) {
		t.Fatal("perfil Windows Spooler com nome não foi reconhecido")
	}
	if profileConfigured(PrinterProfile{Transport: "windows_spooler", PrinterID: "elgin"}) {
		t.Fatal("printer_id sozinho não deve configurar um perfil do Spooler")
	}
}

func TestDiscoverPrintersReturnsNotImplementedOutsideWindows(t *testing.T) {
	// No Linux a descoberta usa `lpstat` (CUPS): com CUPS instalado a rota
	// responde 200, então a expectativa de 501 só vale em macOS/BSD.
	if runtime.GOOS == "linux" {
		t.Skip("no Linux a descoberta é feita via lpstat; ver transport_cups_test.go")
	}
	d := &Daemon{}
	rec := httptest.NewRecorder()
	d.discoverPrinters(rec, httptest.NewRequest(http.MethodGet, "/api/v1/printers/discover", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, quero %d", rec.Code, http.StatusNotImplemented)
	}
}
