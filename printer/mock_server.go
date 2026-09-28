package main

import (
	"fmt"
	"io"
	"net"
	"os"
)

func main() {
	porta := ":9100"
	listener, err := net.Listen("tcp", porta)
	if err != nil {
		fmt.Printf("Erro ao iniciar servidor mock: %v\n", err)
		os.Exit(1)
	}
	defer listener.Close()

	fmt.Printf("🖨️  MOCK IMPRESSORA TÉRMICA escutando em 127.0.0.1%s...\n", porta)

	for {
		conn, err := listener.Accept()
		if err != nil {
			continue
		}

		go func(c net.Conn) {
			defer c.Close()
			dados, err := io.ReadAll(c)
			if err != nil && err != io.EOF {
				fmt.Printf("Erro ao ler dados: %v\n", err)
				return
			}

			fmt.Println("\n================ [ SAÍDA DA IMPRESSORA ] ================")
			fmt.Print(string(dados))
			fmt.Println("=========================================================\n")
		}(conn)
	}
}
