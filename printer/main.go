package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
)

type Item struct {
	Descricao string  `json:"descricao"`
	Qtd       int     `json:"qtd"`
	Valor     float64 `json:"valor"`
}

type SolicitacaoImpressao struct {
	EnderecoImpressora string `json:"endereco_impressora"` // Ex: "127.0.0.1:9100" (Rede/TCP)
	NomeEmpresa        string `json:"nome_empresa"`
	CNPJ               string `json:"cnpj"`
	ChaveAcesso        string `json:"chave_acesso"` // Chave de 44 dígitos da NFC-e
	URLQRCode          string `json:"url_qrcode"`   // URL de consulta do QR Code SEFAZ
	Itens              []Item `json:"itens"`
	Total              float64`json:"total"`
	AbrirGaveta        bool   `json:"abrir_gaveta"`
	CortarPapel        bool   `json:"cortar_papel"`
}

func habilitarCORS(w *http.ResponseWriter) {
	(*w).Header().Set("Access-Control-Allow-Origin", "*")
	(*w).Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	(*w).Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// Função utilitária para adicionar o QR Code ESC/POS nativo ao buffer de bytes
func adicionarQRCodeESCPOS(buffer []byte, urlQRCode string) []byte {
	conteudo := []byte(urlQRCode)
	tamanho := len(conteudo) + 3

	pL := byte(tamanho % 256)
	pH := byte(tamanho / 256)

	// 1. Alinhar no centro
	buffer = append(buffer, []byte{0x1B, 0x61, 1}...)

	// 2. Definir o modelo do QR Code (Model 2)
	buffer = append(buffer, []byte{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00}...)

	// 3. Ajustar o tamanho do módulo (Tamanho do pixel: 4)
	buffer = append(buffer, []byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x04}...)

	// 4. Nível de correção de erros (Nível M - 15%)
	buffer = append(buffer, []byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x48}...)

	// 5. Armazenar o conteúdo da URL no buffer da impressora
	headerArmazenamento := []byte{0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x80, 0x30}
	buffer = append(buffer, headerArmazenamento...)
	buffer = append(buffer, conteudo...)

	// 6. Imprimir o QR Code armazenado
	buffer = append(buffer, []byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30}...)

	// Restaurar alinhamento à esquerda
	buffer = append(buffer, []byte{0x1B, 0x61, 0}...)

	return buffer
}

func montarBufferESCPOS(dados SolicitacaoImpressao) []byte {
	var b []byte

	// Comandos ESC/POS
	escInit := []byte{0x1B, 0x40}                   // ESC @ (Inicializa)
	alignCenter := []byte{0x1B, 0x61, 1}            // ESC a 1 (Centraliza)
	alignLeft := []byte{0x1B, 0x61, 0}              // ESC a 0 (Esquerda)
	boldOn := []byte{0x1B, 0x45, 1}                 // ESC E 1 (Negrito ON)
	boldOff := []byte{0x1B, 0x45, 0}                // ESC E 0 (Negrito OFF)
	cutPaper := []byte{0x1D, 0x56, 66, 0}           // GS V 66 0 (Guilhotina)
	openDrawer := []byte{0x10, 0x14, 0x01, 0x00, 5}  // DLE DC4 (Abre gaveta)

	// 1. Inicializa
	b = append(b, escInit...)

	// 2. Cabeçalho
	b = append(b, alignCenter...)
	b = append(b, boldOn...)
	b = append(b, []byte(fmt.Sprintf("%s\n", dados.NomeEmpresa))...)
	b = append(b, boldOff...)
	b = append(b, []byte(fmt.Sprintf("CNPJ: %s\n", dados.CNPJ))...)
	b = append(b, []byte("------------------------------------------\n")...)
	b = append(b, []byte("  DANFE NFC-e - Documento Auxiliar da Nota\n")...)
	b = append(b, []byte("   Fiscal de Consumidor Eletronica        \n")...)
	b = append(b, []byte("------------------------------------------\n")...)

	// 3. Itens
	b = append(b, alignLeft...)
	for _, item := range dados.Itens {
		totalItem := float64(item.Qtd) * item.Valor
		linha := fmt.Sprintf("%-20s %2dx %6.2f %7.2f\n", item.Descricao, item.Qtd, item.Valor, totalItem)
		b = append(b, []byte(linha)...)
	}

	// 4. Totais
	b = append(b, []byte("------------------------------------------\n")...)
	b = append(b, boldOn...)
	b = append(b, []byte(fmt.Sprintf("TOTAL:                         R$ %7.2f\n", dados.Total))...)
	b = append(b, boldOff...)
	b = append(b, []byte("------------------------------------------\n")...)

	// 5. Chave de Acesso e Informações Fiscais
	if dados.ChaveAcesso != "" {
		b = append(b, alignCenter...)
		b = append(b, []byte("Consulte pela Chave de Acesso em:\nhttp://www.sefaz.rs.gov.br/nfce/consulta\n")...)
		b = append(b, []byte(fmt.Sprintf("%s\n\n", dados.ChaveAcesso))...)
	}

	// 6. QR Code
	if dados.URLQRCode != "" {
		b = adicionarQRCodeESCPOS(b, dados.URLQRCode)
		b = append(b, []byte("\n")...)
	}

	b = append(b, []byte("\n\n")...)

	// 7. Encerramento (Gaveta / Corte)
	if dados.AbrirGaveta {
		b = append(b, openDrawer...)
	}

	if dados.CortarPapel {
		b = append(b, cutPaper...)
	}

	return b
}

func enviarParaImpressora(endereco string, buffer []byte) error {
	conn, err := net.Dial("tcp", endereco)
	if err != nil {
		return err
	}
	defer conn.Close()

	_, err = conn.Write(buffer)
	return err
}

func imprimirHandler(w http.ResponseWriter, r *http.Request) {
	habilitarCORS(&w)

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var req SolicitacaoImpressao
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "JSON inválido: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.EnderecoImpressora == "" {
		req.EnderecoImpressora = "127.0.0.1:9100" // Endereço padrão de teste
	}

	buffer := montarBufferESCPOS(req)

	err = enviarParaImpressora(req.EnderecoImpressora, buffer)
	if err != nil {
		log.Printf("[ERRO] Falha ao enviar para impressora (%s): %v\n", req.EnderecoImpressora, err)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(fmt.Sprintf(`{"status": "erro", "mensagem": "Não foi possível conectar à impressora: %v"}`, err)))
		return
	}

	log.Printf("[OK] Cupom com QR Code impresso em %s (%d bytes)\n", req.EnderecoImpressora, len(buffer))
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status": "sucesso", "mensagem": "Comando enviado com sucesso!"}`))
}

func main() {
	http.HandleFunc("/imprimir", imprimirHandler)

	porta := ":8080"
	fmt.Printf("🚀 Agente de Impressão PDV rodando em http://localhost%s\n", porta)
	log.Fatal(http.ListenAndServe(porta, nil))
}
