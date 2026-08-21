package main

import (
	"errors"
	"fmt"
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
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"toutiao","document":{"title":"标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/cover.jpg"}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Platform != "toutiao" || input.Document.Title != "标题" || len(input.Document.Blocks) != 1 {
		t.Fatalf("unexpected input: %#v", input)
	}
}

func TestReadBaijiaOneShotPlatformOptions(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"baijia","document":{"title":"正常文章标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/cover.jpg","platformOptions":{"baijia":{"smartCreation":["autoPodcast"],"declarations":["aiGenerated","source"],"sourceDate":"2026-08-20","sourceLocation":"河北省 / 沧州市"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.PlatformOptions.Baijia == nil || len(input.PlatformOptions.Baijia.SmartCreation) != 1 || len(input.PlatformOptions.Baijia.Declarations) != 2 {
		t.Fatalf("unexpected platform options: %#v", input.PlatformOptions)
	}
}

func TestRejectsInvalidBaijiaOneShotPlatformOption(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"baijia","document":{"title":"正常文章标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/cover.jpg","platformOptions":{"baijia":{"declarations":["sometimes"]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFill(input); err == nil {
		t.Fatal("expected invalid platform option to be rejected")
	}
}

func TestBaijiaPlatformOptionsAllowEmptyGroups(t *testing.T) {
	coverPath := filepath.Join(t.TempDir(), "cover.jpg")
	if err := os.WriteFile(coverPath, []byte("cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	input, err := readFillInput(nil, strings.NewReader(fmt.Sprintf(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"baijia","document":{"title":"正常文章标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":%q,"platformOptions":{"baijia":{"smartCreation":[],"declarations":[]}}}`, coverPath)))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFill(input); err != nil {
		t.Fatalf("empty option groups should be valid: %v", err)
	}
}

func TestBaijiaSourceDeclarationRequiresDetails(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"baijia","document":{"title":"正常文章标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/cover.jpg","platformOptions":{"baijia":{"declarations":["source"]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFill(input); err == nil {
		t.Fatal("source declaration without date and location should be rejected")
	}
}

func TestReadFillInputFromFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "request.json")
	if err := os.WriteFile(path, []byte(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"toutiao","document":{"title":"标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/cover.jpg"}`), 0o600); err != nil {
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
	_, err := readFillInput(nil, strings.NewReader(`{"platform":"toutiao","document":{"title":"标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"/tmp/a.jpg","extra":true}`))
	if err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestReadPublishConfirmation(t *testing.T) {
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"sohu","document":{"title":"正常文章标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"","confirmPublish":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !input.ConfirmPublish {
		t.Fatal("expected explicit publish confirmation")
	}
}

func TestInstructionsAndSchemaAreAvailableOffline(t *testing.T) {
	previous := buildMode
	buildMode = "development"
	t.Cleanup(func() { buildMode = previous })
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

func TestProductionProfileDoesNotExposeDeveloperCommands(t *testing.T) {
	previous := buildMode
	buildMode = "production"
	t.Cleanup(func() { buildMode = previous })
	for _, args := range [][]string{{"discover"}, {"platforms"}, {"show"}, {"open", "toutiao"}, {"projects"}, {"project", "export", "id", "--output", "out.json"}} {
		_, _, err := run(args)
		if err == nil {
			t.Fatalf("production CLI exposed developer command %v", args)
		}
		var typed *cliError
		if !errors.As(err, &typed) || typed.code != "COMMAND_NOT_EXPOSED" {
			t.Fatalf("unexpected error for %v: %v", args, err)
		}
	}
}

func TestProductionProfileAllowsProjectListAndSelect(t *testing.T) {
	previous := buildMode
	buildMode = "production"
	t.Cleanup(func() { buildMode = previous })
	t.Setenv("GEO_PUBLISHER_USER_DATA_DIR", t.TempDir())
	for _, args := range [][]string{{"project", "list"}, {"project", "select", "11111111-1111-4111-8111-111111111111"}} {
		_, _, err := run(args)
		var typed *cliError
		if errors.As(err, &typed) && typed.code == "COMMAND_NOT_EXPOSED" {
			t.Fatalf("production CLI rejected required multi-customer command %v", args)
		}
	}
}

func TestProductionProjectCreateRequiresExplicitConfirmation(t *testing.T) {
	previous := buildMode
	buildMode = "production"
	t.Cleanup(func() { buildMode = previous })
	directory := t.TempDir()
	path := filepath.Join(directory, "project.json")
	if err := os.WriteFile(path, []byte(`{"name":"客户 A","companyName":"公司 A"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := run([]string{"project", "create", "--input", path})
	var typed *cliError
	if !errors.As(err, &typed) || typed.code != "PROJECT_CREATE_CONFIRMATION_REQUIRED" {
		t.Fatalf("expected confirmation error, got %v", err)
	}
}

func TestProductionSchemaDocumentsConfirmedProjectCreation(t *testing.T) {
	previous := buildMode
	buildMode = "production"
	t.Cleanup(func() { buildMode = previous })
	if got := string(commandSchema()); !strings.Contains(got, "confirmCreate=true") {
		t.Fatalf("production schema omitted project confirmation: %s", got)
	}
}

func TestProductionSchemaDocumentsMaterialOrganizer(t *testing.T) {
	previous := buildMode
	buildMode = "production"
	t.Cleanup(func() { buildMode = previous })
	if got := string(commandSchema()); !strings.Contains(got, `"material"`) {
		t.Fatalf("production schema omitted material organizer: %s", got)
	}
}

func TestMaterialAnalyzeRejectsInvalidInputBeforeDesktopCall(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "analysis.json")
	if err := os.WriteFile(path, []byte(`not-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := runMaterial([]string{"analyze", "11111111-1111-4111-8111-111111111111", "--material", "image-a", "--input", path})
	if err == nil || !strings.Contains(err.Error(), "有效 JSON") {
		t.Fatalf("expected local JSON validation error, got %v", err)
	}
}

func TestDevelopmentProfileIsExplicit(t *testing.T) {
	previous := buildMode
	buildMode = "development"
	t.Cleanup(func() { buildMode = previous })
	if got := string(instructions()); !strings.Contains(got, `"profile":"development"`) {
		t.Fatalf("development instructions did not identify profile: %s", got)
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
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"toutiao","document":{"title":"正常标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":"`+cover+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFill(input); err != nil {
		t.Fatal(err)
	}
}

func TestValidateZhihuDoesNotRequireCover(t *testing.T) {
	err := validateFill(fillInput{ProjectID: "11111111-1111-4111-8111-111111111111", Platform: "zhihu", Document: articleDocument{Title: "知乎标题", Blocks: []articleBlock{{Type: "paragraph", Text: "正文"}}}})
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

func TestControlEndpointUsesDesktopDiscoveryInsteadOfShellHome(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("GEO_PUBLISHER_USER_DATA_DIR", directory)
	t.Setenv("GEO_PUBLISHER_CONTROL_ENDPOINT", "")
	expected := "/tmp/geo-publisher-a1b2c3d4e5f6.sock"
	if runtime.GOOS == "windows" {
		expected = `\\.\pipe\geo-publisher-a1b2c3d4e5f6`
	}
	record := []byte(`{"controlEndpoint":"` + strings.ReplaceAll(expected, `\`, `\\`) + `"}`)
	if err := os.WriteFile(filepath.Join(directory, "discovery.json"), record, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := controlEndpoint(); got != expected {
		t.Fatalf("CLI ignored desktop discovery endpoint: got %q, want %q", got, expected)
	}
}

func TestControlEndpointRejectsInvalidDiscoveryValue(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("GEO_PUBLISHER_USER_DATA_DIR", directory)
	t.Setenv("GEO_PUBLISHER_CONTROL_ENDPOINT", "")
	if err := os.WriteFile(filepath.Join(directory, "discovery.json"), []byte(`{"controlEndpoint":"malicious-endpoint"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := controlEndpoint(); got == "malicious-endpoint" {
		t.Fatal("CLI accepted an invalid discovery endpoint")
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
