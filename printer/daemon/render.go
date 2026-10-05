package main

import (
	"fmt"
	"strings"
)

// Este arquivo é o renderizador ESC/POS: vira template + pedido nos bytes que
// saem pela socket da impressora.
//
// Regra que não se negocia: a saída é contrato. `frontend/src-tauri/src/printing/escpos.rs`
// é um espelho deste arquivo e os testes dos dois lados comparam byte a byte
// contra `testdata/golden/*.bin`. Melhorar a saída aqui quebra a paridade
// Go↔Rust e a comparação deixa de provar alguma coisa — então qualquer
// mudança de byte é deliberada, com o golden regenerado pelo Go
// (UPDATE_GOLDEN=1) e nunca escrito à mão.
//
// A ordem dos comandos dentro de um bloco também é byte, não estilo: um bloco
// `text` emite align → bold → size → texto → size("") → bold(false). Sem o
// "voltar ao normal" no fim, o separador seguinte herda o negrito ou o tamanho
// dobrado da última linha.

// escpos acumula os bytes do cupom.
type escpos struct{ data []byte }

func (e *escpos) init() { e.data = append(e.data, 0x1b, 0x40) }

// line acrescenta texto + quebra. O texto chega aqui já codificado e
// sanitizado por renderWith: line só concatena.
func (e *escpos) line(s string) { e.data = append(e.data, []byte(s+"\n")...) }

func (e *escpos) align(a string) {
	v := byte(0)
	if a == "center" {
		v = 1
	}
	if a == "right" {
		v = 2
	}
	e.data = append(e.data, 0x1b, 0x61, v)
}

func (e *escpos) bold(on bool) {
	v := byte(0)
	if on {
		v = 1
	}
	e.data = append(e.data, 0x1b, 0x45, v)
}

// size reemite também o "normal": quem chama depois de um "double" depende
// desse retorno, e omitir o comando seria mais bytes, não menos.
func (e *escpos) size(s string) {
	if s == "double" {
		e.data = append(e.data, 0x1d, 0x21, 0x11)
	} else {
		e.data = append(e.data, 0x1d, 0x21, 0x00)
	}
}

func (e *escpos) feed(n int) {
	for i := 0; i < n; i++ {
		e.data = append(e.data, '\n')
	}
}

// cut é GS V B 0 — corte parcial com alimentação, para a bobina 80 mm não cortar
// a próxima comanda pela metade.
func (e *escpos) cut() { e.data = append(e.data, 0x1d, 0x56, 0x42, 0x00) }

func (e *escpos) bytes() []byte { return e.data }

// render é o render lógico: UTF-8, sem ESC t. É o que os goldens e o espelho
// Rust esperam, então ele nunca passa por code page.
func render(t Template, order Order) ([]byte, error) {
	return renderWith(t, order, nil)
}

// renderForProfile é o render de produção: aplica a code page do perfil. Com
// encoding utf-8 o encoder é nil e o resultado é idêntico a render.
func renderForProfile(t Template, order Order, profile PrinterProfile) ([]byte, error) {
	enc, err := encoderFor(profile)
	if err != nil {
		return nil, err
	}
	return renderWith(t, order, enc)
}

// renderWith faz o trabalho. enc nil = UTF-8 lógico.
func renderWith(t Template, order Order, enc *encoder) ([]byte, error) {
	b := &escpos{}
	b.init()
	if enc != nil {
		// ESC t logo depois do ESC @ e antes de qualquer bloco: a página precisa
		// valer desde o primeiro byte de texto, e o init do cupom é o único
		// ponto onde a impressora ainda está no estado dela.
		b.data = append(b.data, 0x1b, 0x74, byte(enc.codePage))
	}

	// emit é o único caminho por onde texto do pedido vira byte: sanitiza
	// (nada de ESC/POS vindo de nome de item) e codifica na página. Passar por
	// aqui em vez de dentro de line() é o que mantém o builder burro e
	// impossível de usar errado.
	emit := func(s string) string {
		if enc == nil {
			return sanitizeText(s)
		}
		return string(enc.encode(sanitizeText(s)))
	}

	for _, block := range t.Blocks {
		switch block.Type {
		case "text":
			b.align(block.Align)
			b.bold(block.Bold)
			b.size(block.Size)
			b.line(emit(expand(block.Value, order)))
			b.size("")
			b.bold(false)
		case "separator":
			b.align("left")
			b.line(emit(strings.Repeat("-", t.Columns)))
		case "items":
			b.align("left")
			for _, item := range order.Items {
				b.bold(true)
				b.line(emit(fmt.Sprintf("%dx %s", item.Quantity, item.Name)))
				b.bold(false)
				for _, addon := range item.Addons {
					b.line(emit("  + " + addon))
				}
				if item.Notes != "" {
					b.line(emit("  OBS: " + item.Notes))
				}
			}
		case "notes":
			if order.Notes != "" {
				b.bold(true)
				b.line(emit("OBSERVAÇÕES"))
				b.bold(false)
				b.line(emit(order.Notes))
			}
		case "customer":
			b.bold(true)
			b.line(emit("CLIENTE"))
			b.bold(false)
			b.line(emit(order.Customer.Name))
			b.line(emit("Telefone: " + order.Customer.Phone))
		case "delivery":
			b.bold(true)
			b.line(emit("ENDEREÇO"))
			b.bold(false)
			b.line(emit(order.Delivery.Address + ", " + order.Delivery.Number))
			// Condicionais: cupom de entrega para número e bairro vazios sai com
			// meia linha "Complemento: " solta, e a cozinha ligando para conferir o
			// endereço perde tempo.
			if order.Delivery.Complement != "" {
				b.line(emit("Complemento: " + order.Delivery.Complement))
			}
			if order.Delivery.Neighborhood != "" {
				b.line(emit("Bairro: " + order.Delivery.Neighborhood))
			}
			if order.Delivery.Reference != "" {
				b.line(emit("Referência: " + order.Delivery.Reference))
			}
		case "payment":
			b.line(emit("Pagamento: " + order.Payment.Method))
			if order.Payment.ChangeCents > 0 {
				b.line(emit("Troco: " + money(order.Payment.ChangeCents)))
			}
		case "total":
			b.align("right")
			b.bold(true)
			b.line(emit("TOTAL: " + money(order.TotalCents)))
			b.bold(false)
		case "qrcode":
			b.align("center")
			if err := addQRCode(b, emit(expand(block.Value, order))); err != nil {
				return nil, err
			}
		case "feed":
			b.feed(block.Lines)
		case "cut":
			b.cut()
		default:
			// Erro, não silêncio: um template com typo precisa aparecer, senão o
			// cupom sai sem a seção e o operador só percebe quando o cliente
			// reclama do papel em branco.
			return nil, fmt.Errorf("bloco desconhecido: %s", block.Type)
		}
	}
	return b.bytes(), nil
}

// expand troca as 8 chaves conhecidas do pedido.
//
// Sequencial e com ReplaceAll (o ancestral e o espelho Rust concordam no
// resultado para cardápio real): o Rust faz passada única, que é estritamente
// melhor, mas divergir aqui mudaria bytes e o golden é a lei.
func expand(value string, o Order) string {
	replacements := [][2]string{
		{"{{order.number}}", o.Number},
		{"{{order.created_at}}", o.CreatedAt},
		{"{{order.type}}", strings.ToUpper(o.Type)},
		{"{{order.notes}}", o.Notes},
		{"{{fiscal.company}}", o.Fiscal.Company},
		{"{{fiscal.cnpj}}", o.Fiscal.CNPJ},
		{"{{fiscal.access_key}}", o.Fiscal.AccessKey},
		{"{{fiscal.qr_code_url}}", o.Fiscal.QRCodeURL},
	}
	for _, kv := range replacements {
		value = strings.ReplaceAll(value, kv[0], kv[1])
	}
	return value
}

// money formata centavos em reais: vírgula e dois dígitos, sem símbolo de real
// grudado no número (o operador lê a coluna alinhada).
func money(c int64) string { return fmt.Sprintf("R$ %d,%02d", c/100, c%100) }

// addQRCode emite GS ( k: modelo 2, módulo 4, correção M, armazena+imprime.
//
// É inline e NÃO pode delegar a GenerateQRCodeCommand (encoding.go): aquela
// emite 31 44 <ec> (correção como parâmetro) e o golden do cupom fiscal usa
// 31 45 30. São sequências diferentes e o byte 45 é o que a impressora da loja
// entende.
func addQRCode(e *escpos, value string) error {
	value = sanitizeText(value)
	if value == "" {
		// O fiscal-default tem bloco qrcode com {{fiscal.qr_code_url}}: sem URL
		// o cupom sai sem QR, que é melhor do que sair com a sequência
		// completa e um QR vazio desenhado na bobina.
		return nil
	}
	data := []byte(value)
	if len(data) > qrMaxBytes {
		// storeLen = len+3 estoura o par de 16 bits e o tamanho dá a volta: o
		// resto do payload vira comando ESC/POS na impressora. Erro aqui é
		// visível no job; bytes corrompidos saem como cupom cortado.
		return fmt.Errorf("QR Code excede %d bytes (%d)", qrMaxBytes, len(data))
	}
	size := len(data) + 3
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 67, 4)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 69, 48)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, byte(size), byte(size>>8), 49, 80, 48)
	e.data = append(e.data, data...)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48)
	e.feed(1)
	return nil
}
