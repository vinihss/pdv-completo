package ui

import (
	"os"
	"testing"
)

func TestIsTerminal(t *testing.T) {
	tempFile, err := os.CreateTemp("", "terminal-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	if IsTerminal(tempFile) {
		t.Fatalf("expected regular file to not be a terminal device")
	}
}

func TestLogAndWarnMsg(t *testing.T) {
	// Simple sanity call check that they execute without panic
	LogMsg("test log: %s", "ok")
	WarnMsg("test warning: %s", "careful")
}
