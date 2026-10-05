package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// loadTemplates parte dos templates embutidos no binário e deixa o arquivo do
// cliente sobrepor por id.
//
// A ordem importa: os embutidos primeiro, o disco depois por id. Sem o
// embutido, uma instalação pela metade (update do app, antivírus limpando a
// pasta) deixaria o serviço sem subir — e um PDV sem impressão é um PDV fechado.
//
// O mapa só é publicado no fim, sob lock: publicar aos poucos deixaria uma
// leitura concorrente achando metade dos templates.
func (d *Daemon) loadTemplates() error {
	loaded := map[string]Template{}

	entries, err := embeddedTemplates.ReadDir("templates")
	if err != nil {
		return fmt.Errorf("ler templates embutidos: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := embeddedTemplates.ReadFile("templates/" + entry.Name())
		if err != nil {
			return fmt.Errorf("ler template embutido %s: %w", entry.Name(), err)
		}
		template, err := parseTemplate(entry.Name(), content)
		if err != nil {
			return err
		}
		loaded[template.ID] = template
	}

	if dir := d.cfg.TemplatesDir; dir != "" {
		custom, err := os.ReadDir(dir)
		if err != nil {
			// Diretório inexistente é o caso comum de uma instalação que nunca
			// customizou nada — e os embutidos já cobrem o baseline. Qualquer
			// outro erro (permissão, path bloqueado por antivírus) é problema de
			// verdade: subir assim esconderia o técnico que o arquivo do cliente
			// não entrou.
			if !os.IsNotExist(err) {
				return fmt.Errorf("ler templates: %w", err)
			}
		} else {
			for _, entry := range custom {
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
					continue
				}
				content, err := os.ReadFile(filepath.Join(dir, entry.Name()))
				if err != nil {
					return fmt.Errorf("ler template %s: %w", entry.Name(), err)
				}
				template, err := parseTemplate(entry.Name(), content)
				if err != nil {
					return err
				}
				loaded[template.ID] = template
			}
		}
	}

	d.mu.Lock()
	d.templates = loaded
	d.mu.Unlock()
	return nil
}

// parseTemplate valida o arquivo. Um block type desconhecido é erro e não
// ignora silenciosamente: o renderer não sabe o que fazer com ele, e o efeito
// seria um cupom silenciosamente incompleto — o cliente impresso com uma linha
// a menos do que o layouter desenhou.
func parseTemplate(name string, content []byte) (Template, error) {
	var template Template
	if err := json.Unmarshal(content, &template); err != nil {
		return Template{}, fmt.Errorf("template %s inválido: %w", name, err)
	}
	if template.ID == "" || template.Destination == "" {
		return Template{}, fmt.Errorf("template %s sem id/destination", name)
	}
	for _, block := range template.Blocks {
		switch block.Type {
		case "text", "separator", "items", "notes", "customer",
			"delivery", "payment", "total", "qrcode", "feed", "cut":
		default:
			return Template{}, fmt.Errorf("template %s: bloco desconhecido %q", name, block.Type)
		}
	}
	if template.Columns <= 0 {
		// 48 colunas é a largura da bobina de 80mm com fonte A: cupom de 58mm
		// fica mais seguro em 42, e um 0 aqui viraria "sem largura nenhuma".
		template.Columns = 48
	}
	return template, nil
}

// templateFor acha o template do destino. A conferência de Destination é o que
// impede a comanda da cozinha de sair no cupom fiscal: o id sozinho não é
// prova, porque o id vem do config e o config é escrito à mão.
func (d *Daemon) templateFor(id, destination string) (Template, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if id == "" {
		// Sem id no perfil, vale o primeiro template do destino. A ordem das
		// chaves é estável aqui (sorted) de propósito: iterar o mapa daria um
		// template diferente a cada boot quando o destino tem mais de um, e o
		// mesmo pedido impresso em dois dias sairia com layout diferente.
		ids := make([]string, 0, len(d.templates))
		for candidate := range d.templates {
			ids = append(ids, candidate)
		}
		sort.Strings(ids)
		for _, candidate := range ids {
			if template := d.templates[candidate]; template.Destination == destination {
				return template, nil
			}
		}
		return Template{}, fmt.Errorf("template não encontrado: %s/%s", id, destination)
	}
	template, ok := d.templates[id]
	if !ok || template.Destination != destination {
		return Template{}, fmt.Errorf("template não encontrado: %s/%s", id, destination)
	}
	return template, nil
}
