package main

import (
	"database/sql"
	"errors"
	"sync"
)

// Este arquivo é a fonte única dos tipos compartilhados pelo daemon. Os nomes de
// campo e as tags JSON não são questão de estilo: são o contrato com
// `backend/src/integrations/printer/printer.client.ts`,
// `frontend/src/entities/printer/lib/daemonOrder.js` e com os testes que leem
// as tabelas do SQLite. Mudar uma tag aqui quebra o cliente sem o compilador
// reclamar.

// Config é o config.json inteiro. Os caminhos (data_dir, templates_dir) são
// aceitos relativos, mas são resolvidos contra o diretório do config.json na
// subida: o serviço do Windows roda com CWD em System32.
type Config struct {
	APIToken       string                    `json:"api_token"`
	Listen         string                    `json:"listen"`
	DataDir        string                    `json:"data_dir"`
	TemplatesDir   string                    `json:"templates_dir"`
	AllowedOrigins []string                  `json:"allowed_origins"`
	Printers       map[string]PrinterProfile `json:"printers"`
	Retry          RetryConfig               `json:"retry"`
	Cloud          CloudConfig               `json:"cloud"`
	StatusMonitor  StatusMonitorConfig       `json:"status_monitor"`
}

// StatusMonitorConfig governa o polling DLE EOT que descobre papel ausente e
// impressora offline. Intervalo zero derruba `time.NewTicker`, então a
// normalização acontece antes de o monitor subir (ver runDaemon).
type StatusMonitorConfig struct {
	Enabled        bool `json:"enabled"`
	IntervalSecs   int  `json:"interval_seconds"`
	StaleAfterSecs int  `json:"stale_after_seconds"`
}

type RetryConfig struct {
	MaxAttempts      int `json:"max_attempts"`
	BaseDelaySecs    int `json:"base_delay_seconds"`
	MaxDelaySecs     int `json:"max_delay_seconds"`
	PollIntervalSecs int `json:"poll_interval_seconds"`
}

// PrinterProfile descreve um destino de impressão. Address e PrinterName não se
// auto-excluem porque cada transporte usa um deles (tcp usa address, cups e
// windows_spooler usam printer_name). CodePage é ponteiro porque "não
// configurado" e "configurado com 2" produzem o mesmo ESC t, mas o operador
// precisa poder forçar a página de códigos quando a impressora mente sobre o
// padrão.
type PrinterProfile struct {
	Address     string `json:"address"`
	Template    string `json:"template"`
	Status      bool   `json:"status"`
	Transport   string `json:"transport"`
	PrinterName string `json:"printer_name"`
	PrinterID   string `json:"printer_id"`
	Encoding    string `json:"encoding"`
	CodePage    *int   `json:"code_page"`
}

type Template struct {
	ID          string  `json:"id"`
	Version     int     `json:"version"`
	Destination string  `json:"destination"`
	Columns     int     `json:"columns"`
	Blocks      []Block `json:"blocks"`
}

type Block struct {
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
	Align string `json:"align,omitempty"`
	Bold  bool   `json:"bold,omitempty"`
	Size  string `json:"size,omitempty"`
	Lines int    `json:"lines,omitempty"`
}

type Item struct {
	Name           string   `json:"name"`
	Quantity       int      `json:"quantity"`
	UnitPriceCents int64    `json:"unit_price_cents"`
	Notes          string   `json:"notes"`
	Addons         []string `json:"addons"`
}

// Order tem os blocos aninhados como structs anônimos porque o payload é
// montado por JSON e nunca endereçado campo a campo: escrever à mão um
// `order.customer.name` em Go é o caminho mais curto para um erro de digitação
// que o compilador não vê.
type Order struct {
	Number     string `json:"number"`
	CreatedAt  string `json:"created_at"`
	Type       string `json:"type"`
	Notes      string `json:"notes"`
	Items      []Item `json:"items"`
	TotalCents int64  `json:"total_cents"`
	Customer   struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
	} `json:"customer"`
	Delivery struct {
		Address      string `json:"address"`
		Number       string `json:"number"`
		Complement   string `json:"complement"`
		Neighborhood string `json:"neighborhood"`
		Reference    string `json:"reference"`
	} `json:"delivery"`
	Payment struct {
		Method      string `json:"method"`
		ChangeCents int64  `json:"change_cents"`
	} `json:"payment"`
	Fiscal struct {
		Company   string `json:"company"`
		CNPJ      string `json:"cnpj"`
		AccessKey string `json:"access_key"`
		QRCodeURL string `json:"qr_code_url"`
	} `json:"fiscal"`
}

type PrintRequest struct {
	JobID       string `json:"job_id"`
	OrderID     string `json:"order_id"`
	Destination string `json:"destination"`
	Order       Order  `json:"order"`
}

// Daemon tem de servir como literal de valor zero (`&Daemon{}` nos testes):
// nenhum campo pode depender de um construtor, senão um teste que só quer o
// roteador precisa montar banco e fila para não dar panic.
type Daemon struct {
	cfg       Config
	db        *sql.DB
	templates map[string]Template

	// mu protege templates. Os mapas de healthCache e de locks por impressora se
	// inicializam sozinhos onde são usados, para o literal de valor zero
	// continuar válido.
	mu sync.RWMutex

	// reportMu serializa reportPendingStatuses: o pool tem MaxOpenConns(1) e
	// duas varreduras simultâneas fariam o daemon travar em espera de conexão.
	reportMu sync.Mutex

	// healthMu protege healthCache, o último PrinterStatus conhecido por
	// impressora física (ver ADR-10: a chave é a impressora, não o destino).
	healthMu    sync.RWMutex
	healthCache map[string]PrinterStatus

	// processMu é o fallback de serialização quando a chave de impressora
	// física não pôde ser derivada. O lock por impressora mora em queue.go
	// (lockPrinter); este é o degrau de segurança, não o caminho normal.
	processMu sync.Mutex

	// printerLocks é o mapa de mutexes por impressora física, criado por
	// lockPrinter na primeira chamada. Fica no Daemon (e não em `var` de
	// pacote) porque os testes criam vários daemons no mesmo processo: um mapa
	// compartilhado vaza lock entre instâncias. O ponteiro precisa ser nil até
	// o primeiro uso para `&Daemon{}` continuar um literal válido.
	printerLocks *sync.Map
}

// PrinterStatus é o corpo de /api/printers/status. Os nomes snake_case não são
// escolha de estilo: são o contrato com printer.client.ts, e Supported é
// "status_supported" porque o CUPS e o Spooler do Windows não expõem DLE EOT —
// recusar a consulta não é o mesmo que estar sem papel, e o campo separa os
// dois casos (ADR-09).
type PrinterStatus struct {
	Destination string          `json:"destination"`
	PrinterID   string          `json:"printer_id"`
	Transport   string          `json:"transport"`
	PrinterName string          `json:"printer_name"`
	Address     string          `json:"address"`
	State       string          `json:"state"`
	StateSince  string          `json:"state_since"`
	StatusAge   int             `json:"status_age"`
	Stale       bool            `json:"stale"`
	Failures    int             `json:"failures"`
	Reachable   bool            `json:"reachable"`
	Supported   bool            `json:"status_supported"`
	Ready       bool            `json:"ready"`
	Paper       string          `json:"paper"`
	CoverOpen   bool            `json:"cover_open"`
	CutterError bool            `json:"cutter_error"`
	Error       bool            `json:"error"`
	Offline     bool            `json:"offline"`
	Raw         map[string]byte `json:"raw"`
	Message     string          `json:"message,omitempty"`
	CheckedAt   string          `json:"checked_at"`
}

// errIdempotencyConflict distingue "mesmo pedido, mesmo conteúdo" (reenfileira,
// dedup) de "mesmo pedido, conteúdo diferente" (rejeita). Um cupom fiscal com
// valores divergentes é pior do que não imprimir nada.
var errIdempotencyConflict = errors.New("conflito de idempotência: mesmo pedido com conteúdo diferente")

// Limites de payload. Os nomes de item e observação vêm do cupom de 48 colunas;
// acima disso o texto vira lixo ilegível e o custo é o mesmo. qrMaxBytes é
// limite duro do ESC/POS: o par de 16 bits do GS ( k carrega storeLen = len+3,
// então acima de 65533 o tamanho dá a volta e o resto do QR vaza para a
// impressora como comando.
const (
	maxItemName  = 200
	maxItemNotes = 500
	maxAddons    = 12
	qrMaxBytes   = 65533
)
