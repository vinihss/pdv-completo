//go:build !windows

package main

import "context"

// runAsWindowsService só faz sentido no Windows; nos demais sistemas o
// daemon roda como processo comum (systemd cuida do ciclo de vida).
func runAsWindowsService(func(context.Context) error) bool { return false }
