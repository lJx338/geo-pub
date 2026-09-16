package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPlatformTimeoutCoversSlowPublisherPages(t *testing.T) {
	if platformTimeout < 2*time.Minute {
		t.Fatalf("platform timeout is too short: %s", platformTimeout)
	}
	if defaultTimeout >= platformTimeout {
		t.Fatalf("status timeout should remain shorter than platform timeout")
	}
	if publishTimeout != 4*time.Minute {
		t.Fatalf("publish timeout must stay at the customer-facing four minute limit: %s", publishTimeout)
	}
}

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

func TestReadOperationID(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"platform":"sohu","title":"正常文章标题","html":"<p>正文</p>","coverPath":"","operationId":"publish-test-001","confirmPublish":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.OperationID != "publish-test-001" {
		t.Fatalf("unexpected operation id: %q", input.OperationID)
	}
	if err := validateFill(input); err != nil {
		t.Fatal(err)
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

func TestInstructionsExposeCurrentCapabilities(t *testing.T) {
	var result map[string]any
	if err := json.Unmarshal(instructions(), &result); err != nil {
		t.Fatal(err)
	}
	capabilities, ok := result["capabilities"].([]any)
	if !ok || len(capabilities) != len(controlCapabilities) {
		t.Fatalf("unexpected capabilities: %#v", result["capabilities"])
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
	cover = filepath.ToSlash(cover)
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

func TestControlRequestCarriesCompatibilityMetadata(t *testing.T) {
	request := controlRequest{Action: "status"}
	request.ProtocolVersion = controlProtocolVersion
	request.ClientVersion = version
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"protocolVersion":1`) || !strings.Contains(string(encoded), `"clientVersion":"`+version+`"`) {
		t.Fatalf("request metadata missing: %s", encoded)
	}
}

func TestDiscoveryCompatibilityAllowsDifferentAppVersionWhenProtocolMatches(t *testing.T) {
	if err := validateDiscoveryCompatibility([]byte(`{"appVersion":"0.2.3","protocolVersion":1}`)); err != nil {
		t.Fatalf("compatible protocol should be allowed: %v", err)
	}
}

func TestDiscoveryCompatibilityRejectsDifferentProtocol(t *testing.T) {
	err := validateDiscoveryCompatibility([]byte(`{"appVersion":"0.2.3","protocolVersion":2}`))
	if typed, ok := err.(*cliError); !ok || typed.code != "CONTROL_PROTOCOL_MISMATCH" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestControlEndpointReadsDesktopDiscovery(t *testing.T) {
	directory := t.TempDir()
	expected := "/tmp/geo-publisher-a1b2c3d4e5f6.sock"
	if runtime.GOOS == "windows" {
		expected = `\\.\pipe\geo-publisher-a1b2c3d4e5f6`
	}
	record := []byte(`{"controlEndpoint":"` + strings.ReplaceAll(expected, `\`, `\\`) + `"}`)
	path := filepath.Join(directory, "discovery.json")
	if err := os.WriteFile(path, record, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := controlEndpointFromDiscovery(path); got != expected {
		t.Fatalf("CLI ignored desktop discovery endpoint: got %q, want %q", got, expected)
	}
}

func TestControlEndpointRejectsInvalidDiscoveryValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "discovery.json")
	if err := os.WriteFile(path, []byte(`{"controlEndpoint":"malicious-endpoint"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := controlEndpointFromDiscovery(path); got != "" {
		t.Fatalf("CLI accepted invalid discovery endpoint: %q", got)
	}
}

func TestDiscoveredEndpointValidationCoversWindowsPipe(t *testing.T) {
	if !validDiscoveredControlEndpointForOS(`\\.\pipe\geo-publisher-a1b2c3d4e5f6`, "windows") {
		t.Fatal("valid Windows discovery pipe was rejected")
	}
	if validDiscoveredControlEndpointForOS(`\\.\pipe\geo-publisher-invalid`, "windows") {
		t.Fatal("invalid Windows discovery pipe was accepted")
	}
}
