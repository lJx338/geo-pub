package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFillInputFromStdin(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"platform":"toutiao","title":"标题","html":"<p>正文</p>","coverPath":"/tmp/cover.jpg"}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Platform != "toutiao" || input.Title != "标题" || input.HTML != "<p>正文</p>" {
		t.Fatalf("unexpected input: %#v", input)
	}
}

func TestReadFillInputFromFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "request.json")
	if err := os.WriteFile(path, []byte(`{"platform":"toutiao","title":"标题","html":"<p>正文</p>","coverPath":"/tmp/cover.jpg"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	input, err := readFillInput([]string{"--input", path}, strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	if input.CoverPath != "/tmp/cover.jpg" {
		t.Fatalf("unexpected cover path: %s", input.CoverPath)
	}
}

func TestReadFillInputRejectsUnknownFields(t *testing.T) {
	_, err := readFillInput(nil, strings.NewReader(`{"platform":"toutiao","title":"标题","html":"x","coverPath":"/tmp/a.jpg","extra":true}`))
	if err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestReadPublishConfirmation(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"platform":"sohu","title":"正常文章标题","html":"<p>正文</p>","coverPath":"","confirmPublish":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !input.ConfirmPublish {
		t.Fatal("expected explicit publish confirmation")
	}
}

func TestInstructionsAndSchemaAreAvailableOffline(t *testing.T) {
	for _, command := range []string{"instructions", "schema", "discover"} {
		name, output, err := run([]string{command, "--json"})
		if err != nil {
			t.Fatalf("%s failed: %v", command, err)
		}
		if name != command || len(output) == 0 {
			t.Fatalf("unexpected %s output: %s", command, output)
		}
	}
}

func TestDesktopPathFromDiscovery(t *testing.T) {
	directory := t.TempDir()
	appPath := filepath.Join(directory, "GEO Publisher.exe")
	if err := os.WriteFile(appPath, []byte("exe"), 0o600); err != nil {
		t.Fatal(err)
	}
	discovery := filepath.Join(directory, "discovery.json")
	if err := os.WriteFile(discovery, []byte(`{"appPath":"`+strings.ReplaceAll(appPath, `\`, `\\`)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := desktopPathFromDiscovery(discovery); got != appPath {
		t.Fatalf("unexpected desktop path: %q", got)
	}
}

func TestValidateDoesNotContactDesktop(t *testing.T) {
	directory := t.TempDir()
	cover := filepath.Join(directory, "cover.jpg")
	if err := os.WriteFile(cover, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	input, err := readFillInput(nil, strings.NewReader(`{"platform":"toutiao","title":"正常标题","html":"<p>正文</p>","coverPath":"`+cover+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFill(input); err != nil {
		t.Fatal(err)
	}
}

func TestValidateZhihuDoesNotRequireCover(t *testing.T) {
	err := validateFill(fillInput{Platform: "zhihu", Title: "知乎标题", HTML: "<p>正文</p>"})
	if err != nil {
		t.Fatalf("validateFill returned error: %v", err)
	}
}

func TestControlEndpointMatchesDesktopConvention(t *testing.T) {
	endpoint := controlEndpoint()
	if endpoint == "" || (!strings.Contains(endpoint, "geo-publisher-") && !strings.Contains(endpoint, `geo-publisher-`)) {
		t.Fatalf("unexpected endpoint: %s", endpoint)
	}
}
