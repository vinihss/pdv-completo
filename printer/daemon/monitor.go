package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	PrinterStateUnknown      = "unknown"
	PrinterStateReady        = "ready"
	PrinterStateOffline      = "offline"
	PrinterStatePaperOut     = "paper_out"
	PrinterStatePaperNearEnd = "paper_near_end"
	PrinterStateCoverOpen    = "cover_open"
	PrinterStatePrinterError = "printer_error"
	PrinterStateCutterError  = "cutter_error"
)

var errPrinterBlocked = errors.New("impressora bloqueada por estado físico")

func (d *Daemon) physicalPrinterID(profile PrinterProfile, destination string) string {
	if id := strings.TrimSpace(profile.PrinterID); id != "" {
		return id
	}
	transport := strings.TrimSpace(profile.Transport)
	if transport == "" {
		transport = "tcp"
	}
	target := profile.Address
	if target == "" {
		target = profile.PrinterName
	}
	if target == "" {
		return "destination:" + destination
	}
	return transport + ":" + target
}

func (d *Daemon) statusMonitor() {
	if !d.cfg.StatusMonitor.Enabled {
		return
	}
	d.refreshAllPrinterStatuses()
	ticker := time.NewTicker(time.Duration(d.cfg.StatusMonitor.IntervalSecs) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		d.refreshAllPrinterStatuses()
	}
}

func (d *Daemon) refreshAllPrinterStatuses() {
	seen := map[string]bool{}
	for destination, profile := range d.cfg.Printers {
		key := d.physicalPrinterID(profile, destination)
		if seen[key] || !profileConfigured(profile) {
			continue
		}
		seen[key] = true
		unlock := d.lockPrinter(profile, destination)
		status := d.probePrinterStatus(destination)
		recovered := d.updatePrinterHealth(key, status)
		unlock()
		if recovered {
			d.unblockPrinterJobs(key)
			go d.processDueJobs()
		}
	}
}

func (d *Daemon) queryPrinterStatus(destination string) PrinterStatus {
	profile, ok := d.cfg.Printers[destination]
	if !ok {
		return PrinterStatus{Destination: destination, State: PrinterStateUnknown, Message: "destino não configurado"}
	}
	key := d.physicalPrinterID(profile, destination)
	if cached, ok := d.cachedPrinterStatus(key, destination, profile); ok {
		return cached
	}
	unlock := d.lockPrinter(profile, destination)
	defer unlock()
	status := d.probePrinterStatus(destination)
	d.updatePrinterHealth(key, status)
	return status
}

func (d *Daemon) cachedPrinterStatus(key, destination string, profile PrinterProfile) (PrinterStatus, bool) {
	d.healthMu.RLock()
	status, ok := d.healthCache[key]
	d.healthMu.RUnlock()
	if !ok {
		return PrinterStatus{}, false
	}
	checked, err := time.Parse(time.RFC3339, status.CheckedAt)
	if err != nil || time.Since(checked) > time.Duration(d.cfg.StatusMonitor.StaleAfterSecs)*time.Second {
		return PrinterStatus{}, false
	}
	status.Destination = destination
	status.PrinterID = d.physicalPrinterID(profile, destination)
	status.Transport = profile.Transport
	status.PrinterName = profile.PrinterName
	status.Address = profile.Address
	status.StatusAge = int(time.Since(checked).Seconds())
	status.Stale = false
	return status, true
}

func (d *Daemon) updatePrinterHealth(key string, status PrinterStatus) bool {
	if status.State == "" {
		status.State = derivePrinterState(status)
	}
	now := time.Now().UTC()
	status.CheckedAt = now.Format(time.RFC3339)
	d.healthMu.Lock()
	if d.healthCache == nil {
		d.healthCache = map[string]PrinterStatus{}
	}
	previous, existed := d.healthCache[key]
	if !existed || previous.State != status.State {
		status.StateSince = status.CheckedAt
	} else {
		status.StateSince = previous.StateSince
	}
	if status.State == PrinterStateOffline || status.State == PrinterStateUnknown {
		status.Failures = previous.Failures + 1
	} else {
		status.Failures = 0
	}
	d.healthCache[key] = status
	d.healthMu.Unlock()
	return existed && isBlockingPrinterState(previous.State) && status.State == PrinterStateReady
}

func (d *Daemon) statusForProcessing(destination string, profile PrinterProfile) PrinterStatus {
	key := d.physicalPrinterID(profile, destination)
	if cached, ok := d.cachedPrinterStatus(key, destination, profile); ok {
		return cached
	}
	status := d.probePrinterStatus(destination)
	d.updatePrinterHealth(key, status)
	return status
}

func derivePrinterState(status PrinterStatus) string {
	if !status.Reachable {
		return PrinterStateOffline
	}
	if !status.Supported {
		return PrinterStateUnknown
	}
	if status.CoverOpen {
		return PrinterStateCoverOpen
	}
	if status.Paper == "out" {
		return PrinterStatePaperOut
	}
	if status.CutterError {
		return PrinterStateCutterError
	}
	if status.Error {
		return PrinterStatePrinterError
	}
	if status.Paper == "near_end" {
		return PrinterStatePaperNearEnd
	}
	if status.Ready {
		return PrinterStateReady
	}
	return PrinterStateUnknown
}

func isBlockingPrinterState(state string) bool {
	switch state {
	case PrinterStateOffline, PrinterStatePaperOut, PrinterStateCoverOpen, PrinterStatePrinterError, PrinterStateCutterError:
		return true
	default:
		return false
	}
}

func (d *Daemon) blockJob(jobID, printerID, state, message string) {
	if message == "" {
		message = fmt.Sprintf("impressora bloqueada: %s", state)
	}
	_, _ = d.db.Exec(`UPDATE print_jobs SET status='blocked_printer', printer_id=?, blocked_reason=?, last_error=?, next_attempt_at=NULL, updated_at=? WHERE id=?`, printerID, state, message, time.Now().UTC().Format(time.RFC3339), jobID)
}

func (d *Daemon) unblockPrinterJobs(printerID string) {
	_, _ = d.db.Exec(`UPDATE print_jobs SET status='queued', blocked_reason=NULL, last_error='', next_attempt_at=NULL, updated_at=? WHERE printer_id=? AND status='blocked_printer'`, time.Now().UTC().Format(time.RFC3339), printerID)
}

func (d *Daemon) probeWithContext(ctx context.Context, destination string) PrinterStatus {
	// Mantido como ponto único para futuras sondagens com timeout próprio.
	_ = ctx
	return d.probePrinterStatus(destination)
}
