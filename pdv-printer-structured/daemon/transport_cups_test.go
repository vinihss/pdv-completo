//go:build linux

package main

import "testing"

func TestParseLPStatPrinters(t *testing.T) {
	input := `printer Elgin_MP4200 is idle. enabled since Mon 30 Sep 2026 19:00:00
printer Loja Caixa is printing job 42. enabled since Mon 30 Sep 2026 19:01:00
not a printer line
printer Elgin_MP4200 is idle. enabled since Mon 30 Sep 2026 19:02:00
`

	got := parseLPStatPrinters(input)
	if len(got) != 2 {
		t.Fatalf("filas = %d, want 2: %#v", len(got), got)
	}
	if got[0].Name != "Elgin_MP4200" || got[0].Transport != "cups" {
		t.Fatalf("primeira fila = %#v", got[0])
	}
	if got[1].Name != "Loja Caixa" {
		t.Fatalf("segunda fila = %#v", got[1])
	}
}

func TestParseLPStatPrintersEmpty(t *testing.T) {
	if got := parseLPStatPrinters("scheduler is running\n"); len(got) != 0 {
		t.Fatalf("filas = %#v, want vazio", got)
	}
}

func TestProfileConfiguredCUPSUsesPrinterName(t *testing.T) {
	if !profileConfigured(PrinterProfile{
		Transport:   "cups",
		PrinterName: "Elgin_MP4200",
	}) {
		t.Fatal("perfil CUPS com printer_name não foi reconhecido")
	}
	if profileConfigured(PrinterProfile{Transport: "cups"}) {
		t.Fatal("perfil CUPS sem printer_name não deveria ser reconhecido")
	}
}
