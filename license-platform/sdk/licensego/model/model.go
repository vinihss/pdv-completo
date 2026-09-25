// Package model contém os tipos públicos do SDK — o vocabulário que o
// código da aplicação cliente enxerga. É deliberadamente separado dos
// tipos internos do servidor (internal/license): o SDK é consumido por
// processos externos ao repositório do servidor, então não deve
// depender de internal/*, que o Go já impede de ser importado fora do
// módulo mesmo, e nem replicar exatamente o mesmo formato interno.
package model

import "time"

// State é o estado operacional da licença do ponto de vista do
// cliente — calculado localmente pelo SDK a partir do tempo atual, do
// lease e da janela offline, não recebido diretamente do servidor.
type State string

const (
	StateActive      State = "active"
	StateGracePeriod State = "grace_period"
	StateOffline     State = "offline"
	StateExpired     State = "expired"
	StateInvalid     State = "invalid"
)

// Document é a licença decodificada do payload assinado, no formato
// que a aplicação cliente consulta (features e limits).
type Document struct {
	LicenseID      string
	CustomerID     string
	ProductID      string
	InstallationID string
	Status         string
	Features       map[string]bool
	Limits         map[string]int64
	IssuedAt       time.Time
	ExpiresAt      time.Time
	LeaseUntil     time.Time
	OfflineUntil   time.Time
}

func (d Document) HasFeature(name string) bool {
	return d.Features[name]
}

func (d Document) Limit(name string) (int64, bool) {
	v, ok := d.Limits[name]
	return v, ok
}

// CheckResult é o retorno de Client.Check: o estado calculado e, se
// disponível, o documento da licença correspondente.
type CheckResult struct {
	State    State
	Document Document
	Valid    bool
}
