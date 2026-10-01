//go:build !windows && !linux

package main

import (
	"context"
	"errors"
	"fmt"
)

func newPlatformTransport(profile PrinterProfile) (PrinterTransport, error) {
	return nil, fmt.Errorf("backend %q disponível somente no Windows nesta versão", profile.Transport)
}

func discoverPlatformPrinters() ([]DiscoveredPrinter, error) {
	return nil, errors.New("descoberta do Windows Print Spooler disponível somente no Windows")
}

type unsupportedPlatformTransport struct{}

func (unsupportedPlatformTransport) Send(context.Context, []byte) error {
	return errors.New("transporte não disponível nesta plataforma")
}

func (unsupportedPlatformTransport) Query(context.Context, byte) (byte, error) {
	return 0, errors.New("status não disponível nesta plataforma")
}

func (unsupportedPlatformTransport) Description() string { return "unsupported" }
