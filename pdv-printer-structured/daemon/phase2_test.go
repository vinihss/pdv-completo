//go:build !windows

package main

import (
	"net/http"
	"net/http/httptest"
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
	d := &Daemon{}
	rec := httptest.NewRecorder()
	d.discoverPrinters(rec, httptest.NewRequest(http.MethodGet, "/api/v1/printers/discover", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, quero %d", rec.Code, http.StatusNotImplemented)
	}
}
