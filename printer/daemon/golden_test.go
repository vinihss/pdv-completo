// Golden master do renderizador ESC/POS.
//
// Este é o lado **Go** do contrato de paridade com `frontend/src-tauri`:
// o Rust vai imprimir exatamente estes bytes. Os arquivos em
// `testdata/golden/*.bin` são gerados aqui e consumidos pelo teste Rust
// (`frontend/src-tauri/tests/golden.rs`), que renderiza o mesmo
// `testdata/fixture-order.json` com os mesmos templates e compara byte a
// byte.
//
// Regenerar depois de mudar o renderizador Go:
//
//	UPDATE_GOLDEN=1 go test ./...
//
// A regra que mantém isso honesto: **o esperado nunca é escrito à mão**. Se o
// Rust divergir, corrige-se o Rust; o golden só muda quando o Go muda de
// propósito, e o diff mostra exatamente quais bytes.
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const goldenDir = "testdata/golden"

// fixtureOrder monta o pedido de teste a partir do JSON compartilhado. Ler de
// arquivo (e não montar struct na mão) é proposital: os campos de `Order` são
// structs anônimos, que sãopainéis de escrever à mão, e — mais importante —
// o fixture passa pelo mesmo `json.Unmarshal` que o Rust faz, então o teste
// também cobre o contrato snake_case do payload.
func fixtureOrder(t *testing.T) Order {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "fixture-order.json"))
	if err != nil {
		t.Fatalf("ler fixture: %v", err)
	}
	var order Order
	if err := json.Unmarshal(raw, &order); err != nil {
		t.Fatalf("parsear fixture: %v", err)
	}
	return order
}

func goldenCases(t *testing.T) []struct {
	nome     string
	template Template
} {
	t.Helper()
	entries, err := os.ReadDir("templates")
	if err != nil {
		t.Fatalf("ler templates: %v", err)
	}
	var cases []struct {
		nome     string
		template Template
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("templates", entry.Name()))
		if err != nil {
			t.Fatalf("ler template %s: %v", entry.Name(), err)
		}
		var tpl Template
		if err := json.Unmarshal(raw, &tpl); err != nil {
			t.Fatalf("parsear template %s: %v", entry.Name(), err)
		}
		cases = append(cases, struct {
			nome     string
			template Template
		}{nome: tpl.ID, template: tpl})
	}
	if len(cases) == 0 {
		t.Fatal("nenhum template encontrado")
	}
	return cases
}

// TestGoldenRender é o gerador e o verificador ao mesmo tempo: sem
// UPDATE_GOLDEN compara, com UPDATE_GOLDEN reescreve.
func TestGoldenRender(t *testing.T) {
	order := fixtureOrder(t)
	update := os.Getenv("UPDATE_GOLDEN") == "1"

	for _, tc := range goldenCases(t) {
		t.Run(tc.nome, func(t *testing.T) {
			got, err := render(tc.template, order)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if len(got) == 0 {
				t.Fatal("render devolveu zero bytes")
			}
			path := filepath.Join(goldenDir, tc.nome+".bin")

			if update {
				if err := os.MkdirAll(goldenDir, 0o755); err != nil {
					t.Fatalf("criar %s: %v", goldenDir, err)
				}
				if err := os.WriteFile(path, got, 0o644); err != nil {
					t.Fatalf("gravar golden: %v", err)
				}
				t.Logf("golden %s: %d bytes", path, len(got))
				return
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ler golden %s (rode com UPDATE_GOLDEN=1 para gerar): %v", path, err)
			}
			if !bytes.Equal(want, got) {
				t.Fatalf("bytes divergem do golden %s (%d esperado, %d obtido)", path, len(want), len(got))
			}
		})
	}
}

// TestFixtureCobreTodosOsBlocos é a rede de segurança do fixture: se um bloco
// novo entrar no renderizador e o fixture não exercitá-lo, o golden passa a
// provar menos do que parece. O QR Code e o total só aparecem em parte dos
// templates, então a checagem é por conjunto de tipos presentes no fixture
// completo (todos os templates juntos).
func TestFixtureCobreTodosOsBlocos(t *testing.T) {
	vistos := map[string]bool{}
	for _, tc := range goldenCases(t) {
		for _, b := range tc.template.Blocks {
			vistos[b.Type] = true
		}
	}
	esperados := []string{
		"text", "separator", "items", "notes", "customer",
		"delivery", "payment", "total", "qrcode", "feed", "cut",
	}
	for _, tipo := range esperados {
		if !vistos[tipo] {
			t.Errorf("nenhum template usa o bloco %q — o golden não prova esse caminho", tipo)
		}
	}
}
