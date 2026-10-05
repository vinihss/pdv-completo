package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Este arquivo é a fronteira entre o que o operador escreve à mão e o que o
// daemon usa em memória. Duas regras valem para tudo aqui:
//
//  1. O arquivo existente do cliente nunca é mesclado nem sobrescrito. Quem
//     escreve config.json é o daemon na primeira execução e o técnico depois;
//     um default aplicado por cima apagaria o endereço que a loja já configurou.
//  2. O token devolvido em memória é o mesmo gravado. Divergir deles significa
//     que o cliente usa um token que o restart não reconhece, e o sintoma
//     (impressão para de funcionar depois de reiniciar o serviço) aparece longe
//     da causa.

// mustAbs resolve um caminho contra o CWD e, se não conseguir, devolve o que
// recebeu: um caminho relativo ainda é melhor do que um caminho vazio.
func mustAbs(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

// resolveDir ancora um diretório do config no lugar do config.json. O serviço
// do Windows roda com CWD em System32, então "./data" caía em
// C:\Windows\System32\data e a fila de impressão morria no primeiro restart.
func resolveDir(value, baseDir, fallback string) string {
	if value == "" {
		return filepath.Join(baseDir, fallback)
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	// No Windows o filepath.IsAbs só aceita letra de drive ou UNC, mas "\fila"
	// e "/fila" também são absolutos para quem opera o serviço: são a raiz da
	// unidade corrente. Sem esta checagem eles caíam no Join de baixo e o
	// daemon lia/gravava em %ProgramData%\PDV Printer\fila em vez de C:\fila —
	// silenciosamente, porque o diretório errado é criado sem erro.
	//
	// Só no Windows: no Unix "/" já foi tratado pelo IsAbs acima e "\" é um
	// caractere válido de nome de arquivo, não raiz. Devolvido sem Clean de
	// propósito, porque o Clean do Windows troca "/" por "\" e reescreveria a
	// string que o operador escreveu no config.
	if runtime.GOOS == "windows" && (strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\`)) {
		return value
	}
	return filepath.Join(baseDir, value)
}

// defaultConfigPath é onde o serviço do Windows procura o config quando não
// recebe --config: %ProgramData% é o único lugar que sobrevive a reinstalar o
// app e a atualizar o Windows. O instalador não precisa passar nada por linha
// de comando — o que evita a aspa escapada que o sc.exe exige quando o
// binPath carrega argumentos.
func defaultConfigPath() string {
	if dir := os.Getenv("ProgramData"); dir != "" {
		return filepath.Join(dir, "PDV Printer", "config.json")
	}
	return "config.json"
}

// resolveConfigPath decide de onde sai o config.json. A precedência é
// intencional: flag explícita > primeiro argumento solto > PDV_PRINTER_CONFIG >
// %ProgramData%. O env só entra quando ninguém passou nada na linha de
// comando, senão um PDV_PRINTER_CONFIG herdado do ambiente do técnico
// sobrescreveria o caminho que o instalador passou de propósito.
func resolveConfigPath(args []string) string {
	// A flag com valor separado é consultada primeiro e vale sobre qualquer
	// --config= que apareça antes na linha: quem a escreveu separou o valor por
	// argumento, que é a forma explícita.
	for i, arg := range args {
		if arg == "--config" || arg == "-c" {
			if i+1 < len(args) {
				return args[i+1]
			}
		}
	}
	for _, arg := range args {
		if value, ok := strings.CutPrefix(arg, "--config="); ok {
			return value
		}
	}
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
	}
	if value := os.Getenv("PDV_PRINTER_CONFIG"); value != "" {
		return value
	}
	return defaultConfigPath()
}

func loadConfig(path string) (Config, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		// %w de propósito: ensureConfig precisa distinguir "não existe" (cria o
		// padrão) de "existe e está corrompido" (erro fatal). os.IsNotExist não
		// enxerga através do envelope.
		return Config{}, fmt.Errorf("ler configuração %s: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(content, &cfg); err != nil {
		return Config{}, fmt.Errorf("configuração inválida: %w", err)
	}
	return cfg, nil
}

// ensureConfig carrega o config.json e, se ele não existir, cria um padrão.
// O instalador só precisa apontar o serviço para o caminho: quem escreve o
// arquivo é o próprio daemon, que é o lugar onde a estrutura do arquivo é
// conhecida.
func ensureConfig(path string) (Config, error) {
	cfg, err := loadConfig(path)
	if err == nil {
		// Devolve o que foi lido, sem mesclar: um default aplicado aqui
		// sobrescreveria o listen e o endereço que a loja já configurou.
		return cfg, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	log.Printf("config %s inexistente; criando padrão", path)
	// defaultConfig() é chamada uma única vez e o MESMO valor é o devolvido e
	// o gravado. Chamar duas vezes (aqui e dentro de writeDefaultConfig) gera
	// dois api_token: o cliente passaria a usar um token que o restart não
	// reconhece, e a impressão só falharia depois de reiniciar o serviço.
	cfg = defaultConfig()
	if writeErr := writeDefaultConfig(path, cfg); writeErr != nil {
		// Não é fatal: o serviço do Windows roda com CWD em System32 e a pasta
		// pode estar sem permissão. Imprimir continua funcionando, só não
		// sobrevive a um restart até alguém criar o arquivo.
		log.Printf("aviso: não consegui criar %s (%v); usando padrão em memória", path, writeErr)
	}
	return cfg, nil
}

// writeDefaultConfig grava exatamente a cfg recebida, nunca um default
// recalculado: o token tem de ser o mesmo que o chamador devolveu ao chamador.
func writeDefaultConfig(path string, cfg Config) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0750); err != nil {
			return err
		}
	}
	content, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0640)
}

// defaultConfig é o ponto de partida de uma instalação nova.
//
// As impressoras vêm SEM endereço de propósito: perfil sem endereço faz o
// /health dizer "sem impressora configurada" em vez de mandar um cupom para o
// endereço herdado de outra loja — que é o pior modo de falha possível, porque
// não dá erro, sai papel onde não devia.
func defaultConfig() Config {
	return Config{
		APIToken: newAPIToken(),
		Listen:   "127.0.0.1:8080",
		DataDir:  "./data",
		// Escritos mesmo sem a pasta existir: o arquivo serve de documentação
		// para o técnico (é onde se joga o template customizado da loja) e
		// loadTemplates tolera diretório ausente, então apontar para algo que
		// ainda não existe não impede o serviço de subir.
		TemplatesDir: "./templates",
		AllowedOrigins: []string{
			"tauri://localhost",
			"http://tauri.localhost",
			"http://localhost:1420",
		},
		// Monitor ligado por padrão: perfil sem endereço é pulado por
		// refreshAllPrinterStatuses, então uma instalação nova não paga nada por
		// isso. Já na loja com impressora configurada é o que transforma
		// "sem papel" em bloqueio de job em vez de papel em branco.
		StatusMonitor: StatusMonitorConfig{
			Enabled:        true,
			IntervalSecs:   30,
			StaleAfterSecs: 120,
		},
		Retry: RetryConfig{
			MaxAttempts:      8,
			BaseDelaySecs:    2,
			MaxDelaySecs:     120,
			PollIntervalSecs: 2,
		},
		Printers: map[string]PrinterProfile{
			"kitchen": {Template: "kitchen-default", Status: true},
			"courier": {Template: "courier-default", Status: true},
			"fiscal":  {Template: "fiscal-default", Status: true},
		},
	}
}

// newAPIToken devolve 64 caracteres hex = 256 bits de crypto/rand. A API local
// fica exposta ao navegador (Tauri, PWA) e o único controle real é o token, com
// o CORS barrando origem desconhecida por cima.
func newAPIToken() string {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		// crypto/rand.Read nunca falha em plataforma suportada; se falhar, o
		// token vazio deixa a API em modo de compatibilidade, que é registrado
		// por authorize() — melhor do que um token previsível.
		log.Printf("aviso: crypto/rand falhou (%v); api_token ficou vazio", err)
		return ""
	}
	return hex.EncodeToString(buffer)
}
