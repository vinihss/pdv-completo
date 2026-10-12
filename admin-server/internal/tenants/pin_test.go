package tenants

import "testing"

func TestPinFromOutput(t *testing.T) {
	casos := []struct {
		nome string
		out  string
		pin  string
		ok   bool
	}{
		{
			nome: "linha real do seed",
			out:  "[seed-prod] concluído.\n[seed-prod] Usuário gerente \"Gerente\" criado — PIN: 1234\n[seed-prod] ANOTE ESSE PIN AGORA",
			pin:  "1234",
			ok:   true,
		},
		{
			nome: "com pontuação",
			out:  "criado — PIN: 4321.",
			pin:  "4321",
			ok:   true,
		},
		{
			nome: "sem PIN",
			out:  "[provision] tenant \"umami\" pronto no schema tenant_umami",
			pin:  "",
			ok:   false,
		},
		{
			nome: "vazio",
			out:  "",
			pin:  "",
			ok:   false,
		},
		{
			nome: "PIN sem dígitos",
			out:  "PIN: abc",
			pin:  "",
			ok:   false,
		},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			pin, ok := PinFromOutput(c.out)
			if ok != c.ok || pin != c.pin {
				t.Errorf("PinFromOutput() = (%q, %v), quer (%q, %v)", pin, ok, c.pin, c.ok)
			}
		})
	}
}
