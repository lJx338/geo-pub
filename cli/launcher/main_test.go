package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInsideDataDirectory(t *testing.T) {
	data := dataDirectory()
	if !insideDataDirectory(filepath.Join(data, "bin", "versions", "0.2.5", "geo-publisher-core")) {
		t.Fatal("expected Core CLI inside data directory to be accepted")
	}
	if insideDataDirectory(filepath.Join(data, "..", "outside")) {
		t.Fatal("path outside data directory was accepted")
	}
}

func TestResolveCoreCLIUsesCurrentDiscoveryRecord(t *testing.T) {
	root := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", root)
	} else {
		t.Setenv("HOME", root)
	}
	data := dataDirectory()
	core := filepath.Join(data, "bin", "versions", "0.2.5", "geo-publisher-core")
	if runtime.GOOS == "windows" {
		core += ".exe"
	}
	if err := os.MkdirAll(filepath.Dir(core), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(core, []byte("core"), 0o700); err != nil {
		t.Fatal(err)
	}
	record, err := json.Marshal(discoveryRecord{CoreCLIPath: core, Ready: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(discoveryPath(), record, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := resolveCoreCLI()
	if err != nil {
		t.Fatal(err)
	}
	if got != core {
		t.Fatalf("got %q, want %q", got, core)
	}
}

func TestResolveCoreCLIRejectsOutsidePath(t *testing.T) {
	root := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", root)
	} else {
		t.Setenv("HOME", root)
	}
	data := dataDirectory()
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	record, err := json.Marshal(discoveryRecord{CoreCLIPath: filepath.Join(root, "outside-core"), Ready: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(discoveryPath(), record, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveCoreCLI(); err == nil {
		t.Fatal("expected path outside the data directory to fail")
	}
}
