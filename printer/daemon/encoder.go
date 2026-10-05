package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Este arquivo é a fronteira entre o texto UTF-8 que chega do backend e a
// térmica, que só entende bytes de página de códigos. Os dois riscos são
// simétricos e opostos:
//
//   - mandar UTF-8 cru: acento sai como lixo (ou nem sai) na bobina;
//   - transliterar às cegas: nome de produto vira "??" e o cliente reclama do
//     cardápio, não do daemon.
//
// Por isso a conversão é sempre por tabela declarada, com fallback ASCII
// apenas para o que realmente não existe na página (ver asciiFallback).

// encoder guarda as 128 posições altas (0x80..0xFF) da página escolhida.
// codePage é o valor do ESC t n; ele é separado das posições porque o operador
// pode forçar a página no config quando a impressora mente sobre o padrão
// (ver PrinterProfile.CodePage em types.go).
type encoder struct {
	codePage int
	high     map[rune]byte
	fallback map[rune]string
}

// asciiFallback cobre o que o garçom digita no teclado do celular e não existe
// em nenhuma das três páginas.
//
// CJK e emoji NÃO entram aqui de propósito: mascarár "日" como "?" já é o
// comportamento correto, e inventar transliteração para ideograma produziria
// texto ilegível e falso no cupom fiscal. O que entra é o que tem equivalente
// óbvio em ASCII e cujo equivalente é o que o garçom quis dizer.
//
// O euro também não entra, pelo mesmo motivo e por um a mais: em CP850 — a
// página padrão — ele simplesmente não existe, e trocar um símbolo monetário
// pelo texto "EUR" num cupom fiscal é pior que imprimir "?", porque o "?" pelo
// menos denuncia que faltou sinal. Quem precisa de euro legível configura
// CP858, onde ele tem byte (0xD5).
var asciiFallback = map[rune]string{
	'–': "-",   // en dash
	'—': "-",   // em dash
	'−': "-",   // sinal de menos matemático
	'‘': "'",   // aspa simples esquerda
	'’': "'",   // aspa simples direita / apóstrofo
	'“': `"`,   // aspa dupla esquerda
	'”': `"`,   // aspa dupla direita
	'„': `"`,   // aspa dupla baixa
	'…': "...", // reticências
	'•': "-",   // marcador de lista
	'·': "-",   // ponto médio
	'«': `"`,   // aspa angular esquerda
	'»': `"`,   // aspa angular direita
	'‰': "%",   // por mil
	'´': "'",   // acento grave solto
	'`': "'",   // acento grave
	'№': "N",   // número
	'℃': "C",   // graus Celsius
	'₹': "Rs",  // rupia
}

// As três tabelas foram geradas a partir dos codecs reais
// (golang.org/x/text/encoding/charmap), não digitadas à mão: um acento
// transposto aqui sai errado na bobina e o golden em UTF-8 não denuncia,
// porque o golden só exercita o render lógico.
//
// Cada posição é o code point que aquele byte representa, na ordem dos bytes
// 0x80..0xFF — a direção "byte → rune", que é como a página é definida. Quem
// precisa do sentido inverso é reverseTable, abaixo.
//
// Duas armadilhas ao ler isto:
//   - posição indefinida é o rune 0 (cinco delas na CP1252: 0x81, 0x8D, 0x8F,
//     0x90, 0x9D), para que um byte sem significado não vire um glyph
//     qualquer;
//   - \xad (hífen suave) e \xa0 (espaço não separável) são escapes de BYTE, e
//     um 0xAD sozinho não é UTF-8 válido. reverseTable os decodifica pelo valor
//     do byte; []rune() os trocaria por U+FFFD sem mudar o tamanho da string
//     (128 continua 128), que é exatamente o que esconde o erro.
const (
	// CP850 é o padrão das térmicas de 80mm:bx PCe o euro. As 128 posições são
	// todas definidas.
	cp850High = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\xad±‗¾¶§÷¸°¨·¹³²■\xa0"

	// CP858 é o CP850 com o euro no 0xD5 (o CP850 não tem euro).
	cp858High = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\xad±‗¾¶§÷¸°¨·¹³²■\xa0"

	// CP1252 é a página do Windows: 32 posições de moldura ASCII (0x80-0x9F) e
	// 5 indefinidas (0x81, 0x8D, 0x8F, 0x90, 0x9D). São as 5 posições "\x00"
	// abaixo — caem no fallback ASCII.
	cp1252High = "€\x00‚ƒ„…†‡ˆ‰Š‹Œ\x00Ž\x00\x00‘’“”•–—˜™š›œ\x00žŸ\xa0¡¢£¤¥¦§¨©ª«¬\xad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
)

// reverseTable inverte as tabelas acima para a direção que o encode precisa:
// rune → byte.
//
// A inversão não é um detalhe cosmético. Indexar a tabela por `rune - 0x80`
// presume que o code point do caractere é o byte na página, o que só vale para
// Latin-1: em CP850 o Ç (U+00C7) mora no byte 0x80 e o byte 0xC7 é o Ã.
// Varrendo a página uma vez e guardando o resultado, o encode fica O(1) por
// caractere e a premissa errada some do caminho quente.
func reverseTable(high string) map[rune]byte {
	out := make(map[rune]byte, 128)
	pos := 0
	for i := 0; i < len(high) && pos < 128; {
		r, size := utf8.DecodeRuneInString(high[i:])
		if r == utf8.RuneError && size <= 1 {
			// Byte cru (0xAD, 0xA0): o code point é o próprio valor do byte.
			r, size = rune(high[i]), 1
		}
		switch {
		case r == 0:
			// Posição indefinida: ignorada de propósito, para que o encoder
			// não dependa do sanitizeText ter eliminado o \x00 antes.
		default:
			if _, dup := out[r]; !dup {
				// Rune repetido: vence o primeiro byte, que é o que o decodificador
				// do charmap devolve para as duas posições. Nenhuma das três
				// páginas repete hoje, mas o critério fica escrito para o dia em
				// que alguma repetir.
				out[r] = byte(0x80 + pos)
			}
		}
		pos++
		i += size
	}
	return out
}

// Os mapas são de leitura apenas depois da inicialização do pacote, e o Go
// garante que ela termina antes de qualquer goroutine: um encoder por job
// apontando para o mesmo mapa não é data race, e 3 tabelas × 128 posições é
// custoPaginaMinúsculo.
var (
	cp850HighRev  = reverseTable(cp850High)
	cp858HighRev  = reverseTable(cp858High)
	cp1252HighRev = reverseTable(cp1252High)
)

// encoderFor devolve o encoder do perfil ou (nil, nil) para UTF-8.
//
// O (nil, nil) de UTF-8 é a peça que segura a paridade com o espelho Rust: sem
// encoder, renderWith não emite ESC t e os bytes são os UTF-8 do render
// lógico — que é exatamente o que os goldens e o renderer Rust comparam.
func encoderFor(profile PrinterProfile) (*encoder, error) {
	enc := &encoder{codePage: 2, high: cp850HighRev, fallback: asciiFallback}

	// Case-insensitive e com espaço tolerado: quem escreve o config.json é o
	// técnico, e "CP850" escrito com caixa diferente não é motivo para a
	// impressora parar de funcionar.
	switch strings.ToLower(strings.TrimSpace(profile.Encoding)) {
	case "", "cp850":
		// padrão já montado acima
	case "cp858":
		enc.high = cp858HighRev
		enc.codePage = 19
	case "windows-1252", "cp1252":
		enc.high = cp1252HighRev
		enc.codePage = 16
	case "utf-8", "utf8":
		return nil, nil
	default:
		return nil, fmt.Errorf("encoding desconhecido: %q (use cp850, cp858, windows-1252 ou utf-8)", profile.Encoding)
	}

	// O code_page do config sobrepõe o derivado do nome. Faixa 0-255 porque é o
	// que o ESC t n aceita de fato: um valor fora disso faria a impressora
	// interpretar bytes com uma página aleatória, e o sintoma (texto ilegível)
	// aparece longe da causa (config.json).
	if profile.CodePage != nil {
		if *profile.CodePage < 0 || *profile.CodePage > 255 {
			return nil, fmt.Errorf("code_page fora de 0-255: %d", *profile.CodePage)
		}
		enc.codePage = *profile.CodePage
	}
	return enc, nil
}

// encode converte UTF-8 nos bytes da página. Rune abaixo de 0x80 sai como ele
// mesmo (caminho quente: nome de produto é quase todo ASCII). Rune alto sai
// pelo byte que a página dá a ele, pelo fallback ou por "?" — nessa ordem.
func (e *encoder) encode(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		if r < 0x80 {
			out = append(out, byte(r))
			continue
		}
		if b, ok := e.high[r]; ok {
			out = append(out, b)
			continue
		}
		if repl, ok := e.fallback[r]; ok {
			out = append(out, repl...)
			continue
		}
		out = append(out, '?')
	}
	return out
}

// sanitizeText remove o que a impressora interpretaria como comando.
//
// Tudo que é C0 (0x00-0x1F) vira nada, menos \n que é quebra de linha de
// verdade e \t que vira espaço (a coluna desalinhava o cardápio). O 0x7F
// também sai. As letras vizinhas ficam: \x1dV é o grupo GS + "V", e descartar
// o V junto esconderia texto do garçom sem ganhar nada.
//
// Isto roda antes de tudo, inclusive do QR: um nome de item com \x1d
// injetaria comandos ESC/POS na impressora e o cupom sairia cortado no meio
// (ver TestRenderNaoExecutaComandosVindosDoPedido).
func sanitizeText(s string) string {
	if !needsSanitize(s) {
		return s
	}
	var sb strings.Builder
	sb.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n':
			sb.WriteRune(r)
		case r == '\t':
			sb.WriteByte(' ')
		case r < 0x20 || r == 0x7f:
			// descartado de propósito
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// needsSanitize evita de alocar uma cópia nova para o caso comum (cupom sem
// nenhum byte de controle), que é a maioria.
func needsSanitize(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c == 0x7f {
			return true
		}
	}
	return false
}
