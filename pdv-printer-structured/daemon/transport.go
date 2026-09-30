package main

import (
	"context"
	"errors"
	"fmt"
)

// PrinterTransport é o contrato entre o pipeline de impressão e a interface
// física. A renderização produz ESC/POS; o transporte apenas envia/consulta.
type PrinterTransport interface {
	Send(context.Context, []byte) error
	Query(context.Context, byte) (byte, error)
	Description() string
}

type DiscoveredPrinter struct {
	Name      string `json:"name"`
	Transport string `json:"transport"`
}

type tcpTransport struct{ address string }

func (t tcpTransport) Send(ctx context.Context, data []byte) error {
	return sendTCPContext(ctx, t.address, data)
}

func (t tcpTransport) Query(ctx context.Context, n byte) (byte, error) {
	return queryDLEEOTContext(ctx, t.address, n)
}

func (t tcpTransport) Description() string { return "tcp/9100" }

func transportFor(profile PrinterProfile) (PrinterTransport, error) {
	kind := profile.Transport
	if kind == "" {
		kind = "tcp"
	}
	switch kind {
	case "tcp", "tcp9100":
		if profile.Address == "" {
			return nil, errors.New("endereço TCP da impressora não configurado")
		}
		return tcpTransport{address: profile.Address}, nil
	default:
		transport, err := newPlatformTransport(profile)
		if err != nil {
			return nil, fmt.Errorf("transporte %s: %w", kind, err)
		}
		return transport, nil
	}
}
