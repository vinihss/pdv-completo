//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	printerEnumLocal        = 0x00000002
	printerEnumConnections  = 0x00000004
	errorInsufficientBuffer = 122
)

var (
	winspool             = windows.NewLazySystemDLL("winspool.drv")
	procOpenPrinter      = winspool.NewProc("OpenPrinterW")
	procClosePrinter     = winspool.NewProc("ClosePrinter")
	procStartDocPrinter  = winspool.NewProc("StartDocPrinterW")
	procEndDocPrinter    = winspool.NewProc("EndDocPrinter")
	procStartPagePrinter = winspool.NewProc("StartPagePrinter")
	procEndPagePrinter   = winspool.NewProc("EndPagePrinter")
	procWritePrinter     = winspool.NewProc("WritePrinter")
	procEnumPrinters     = winspool.NewProc("EnumPrintersW")
)

type docInfo1 struct {
	docName    *uint16
	outputFile *uint16
	dataType   *uint16
}

type printerInfo4 struct {
	printerName *uint16
	serverName  *uint16
	attributes  uint32
}

type windowsSpoolerTransport struct {
	printerName string
}

func newPlatformTransport(profile PrinterProfile) (PrinterTransport, error) {
	kind := profile.Transport
	if kind != "windows_spooler" && kind != "winspool" && kind != "spooler" {
		return nil, fmt.Errorf("backend não disponível nesta plataforma: %s", kind)
	}
	if profile.PrinterName == "" {
		return nil, errors.New("printer_name não configurado")
	}
	return windowsSpoolerTransport{printerName: profile.PrinterName}, nil
}

func (t windowsSpoolerTransport) Description() string { return "windows-spooler/raw" }

func (t windowsSpoolerTransport) Send(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("documento ESC/POS vazio")
	}

	name, err := windows.UTF16PtrFromString(t.printerName)
	if err != nil {
		return fmt.Errorf("nome da impressora inválido: %w", err)
	}
	var handle windows.Handle
	result, _, callErr := procOpenPrinter.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&handle)), 0)
	if result == 0 {
		return fmt.Errorf("abrir impressora %q: %w", t.printerName, callErr)
	}
	defer procClosePrinter.Call(uintptr(handle))

	docName, _ := windows.UTF16PtrFromString("PDV Printer")
	dataType, _ := windows.UTF16PtrFromString("RAW")
	doc := docInfo1{docName: docName, dataType: dataType}
	job, _, callErr := procStartDocPrinter.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&doc)))
	if job == 0 {
		return fmt.Errorf("iniciar trabalho na impressora %q: %w", t.printerName, callErr)
	}
	defer procEndDocPrinter.Call(uintptr(handle))

	page, _, callErr := procStartPagePrinter.Call(uintptr(handle))
	if page == 0 {
		return fmt.Errorf("iniciar página na impressora %q: %w", t.printerName, callErr)
	}
	defer procEndPagePrinter.Call(uintptr(handle))

	var written uint32
	result, _, callErr = procWritePrinter.Call(uintptr(handle), uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), uintptr(unsafe.Pointer(&written)))
	if result == 0 {
		return fmt.Errorf("enviar RAW para %q: %w", t.printerName, callErr)
	}
	if written != uint32(len(data)) {
		return fmt.Errorf("spooler aceitou %d de %d bytes para %q", written, len(data), t.printerName)
	}
	return nil
}

func (t windowsSpoolerTransport) Query(context.Context, byte) (byte, error) {
	return 0, errors.New("DLE EOT não é exposto pelo Windows Print Spooler")
}

func discoverPlatformPrinters() ([]DiscoveredPrinter, error) {
	flags := uintptr(printerEnumLocal | printerEnumConnections)
	level := uintptr(4)
	var needed, count uint32
	procEnumPrinters.Call(flags, 0, level, 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)))
	if needed == 0 {
		return []DiscoveredPrinter{}, nil
	}
	buffer := make([]byte, needed)
	result, _, callErr := procEnumPrinters.Call(flags, 0, level, uintptr(unsafe.Pointer(&buffer[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)))
	if result == 0 {
		if callErr != windows.ERROR_INSUFFICIENT_BUFFER && callErr.Error() != windows.Errno(errorInsufficientBuffer).Error() {
			return nil, fmt.Errorf("enumerar impressoras do Windows: %w", callErr)
		}
		return nil, fmt.Errorf("enumerar impressoras do Windows: buffer insuficiente")
	}
	entries := unsafe.Slice((*printerInfo4)(unsafe.Pointer(&buffer[0])), count)
	printers := make([]DiscoveredPrinter, 0, count)
	for _, entry := range entries {
		if entry.printerName == nil {
			continue
		}
		printers = append(printers, DiscoveredPrinter{Name: windows.UTF16PtrToString(entry.printerName), Transport: "windows_spooler"})
	}
	return printers, nil
}
