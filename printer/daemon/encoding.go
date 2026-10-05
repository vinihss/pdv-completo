package main

import (
	"bytes"
	"image"
	"image/color"
	_ "image/png"
)

// GenerateQRCodeCommand cria a sequência ESC/POS para renderizar QR Code nativo
func GenerateQRCodeCommand(data string, size byte, errorCorrection byte) []byte {
	var buf bytes.Buffer

	// Modelo 2
	buf.Write([]byte{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00})

	// Tamanho do módulo
	if size < 1 || size > 16 {
		size = 4
	}
	buf.Write([]byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, size})

	// Correção de erros
	buf.Write([]byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x44, errorCorrection})

	// Enviar dados
	storeLen := len(data) + 3
	pL := byte(storeLen % 256)
	pH := byte(storeLen / 256)
	buf.Write([]byte{0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x80, 0x30})
	buf.WriteString(data)

	// Imprimir
	buf.Write([]byte{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30})

	return buf.Bytes()
}

// ImageToESCPOS converte uma imagem em bytecode raster monocromático (GS v 0)
func ImageToESCPOS(img image.Image) []byte {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	widthBytes := (width + 7) / 8

	var buf bytes.Buffer

	buf.Write([]byte{
		0x1D, 0x76, 0x30, 0x00,
		byte(widthBytes % 256),
		byte(widthBytes / 256),
		byte(height % 256),
		byte(height / 256),
	})

	for y := 0; y < height; y++ {
		for xByte := 0; xByte < widthBytes; xByte++ {
			var b byte = 0
			for bit := 0; bit < 8; bit++ {
				x := xByte*8 + bit
				if x < width {
					c := color.GrayModel.Convert(img.At(x, y)).(color.Gray)
					if c.Y < 128 {
						b |= (1 << (7 - bit))
					}
				}
			}
			buf.WriteByte(b)
		}
	}

	return buf.Bytes()
}
