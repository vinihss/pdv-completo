package licensego

import "time"

// parseTimeLoose decodifica um timestamp RFC3339. Uma string vazia é
// tratada como time.Time zero (não é erro) — acontece quando o
// servidor omite lease_until/offline_until.
func parseTimeLoose(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339, s)
}
