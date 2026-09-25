# Agente Local de Impressão Térmica PDV (ESC/POS com QR Code) em Go

Este projeto contém uma solução completa para integrar aplicações **PDV Web** com **Impressoras Térmicas não-fiscais** (Epson, Bematech, Elgin, Daruma) via comandos diretos **ESC/POS**, incluindo suporte para impressão nativa do **QR Code do DANFE NFC-e**.

---

## 📁 Conteúdo do Pacote

- `main.go`: O servidor do agente local (porta 8080) que processa as requisições HTTP do PDV Web e gera o buffer ESC/POS.
- `mock_server.go`: Emulador de impressora térmica em Go (porta 9100) para testes sem impressora física.
- `pdv_exemplo.html`: Página de teste de integração do front-end.
- `go.mod`: Arquivo do módulo Go.
- `README.md`: Documentação técnica do projeto.

---

## 🚀 Como Executar o Projeto em Modo de Teste

1. **Iniciar o Emulador de Impressora (Mock):**
   ```bash
   go run mock_server.go
   ```

2. **Iniciar o Agente Local de Impressão:**
   ```bash
   go run main.go
   ```

3. **Testar a Impressão:**
   - Abra o arquivo `pdv_exemplo.html` no seu navegador e clique no botão de teste.
   - Ou envie via `curl`:
     ```bash
     curl -X POST http://localhost:8080/imprimir \
       -H "Content-Type: application/json" \
       -d '{
         "endereco_impressora": "127.0.0.1:9100",
         "nome_empresa": "LOJA TESTE",
         "cnpj": "00.000.000/0001-00",
         "chave_acesso": "4326 0900 0000 0000 0000 6500 1000 0000 0110 0000 0018",
         "url_qrcode": "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?chNFe=43260900000000000000650010000000011000000018",
         "itens": [{ "descricao": "Item 1", "qtd": 1, "valor": 10.00 }],
         "total": 10.00,
         "abrir_gaveta": true,
         "cortar_papel": true
       }'
     ```
