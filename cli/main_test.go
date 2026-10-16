package main

import (
	"encoding/json"
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

func TestWechatLayoutSurvivesCLITransport(t *testing.T) {
	for _, theme := range []string{"moyu-green", "red-white", "graphite-minimal", "zen-whitespace", "moyu-ticket", "olive-journal"} {
		request := fmt.Sprintf(`{"platform":"wechat","document":{"title":"采购检查","wechatLayout":{"version":1,"theme":%q,"fontSize":17,"lineHeight":2,"paragraphSpacing":24,"header":false,"eyebrow":"采购观察"},"blocks":[{"type":"paragraph","text":"核对工况","card":{"kind":"intro","label":"先看这里"},"emphasis":[{"text":"工况","style":"underline"}]}]}}`, theme)
		input, err := readFillInput(nil, strings.NewReader(request))
		if err != nil {
			t.Fatal(err)
		}
		if err := validateDocument(input.Document); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(controlRequest{Action: "draft.fill", Document: input.Document})
		if err != nil {
			t.Fatal(err)
		}
		var forwarded struct {
			Document articleDocument `json:"document"`
		}
		if err := json.Unmarshal(data, &forwarded); err != nil {
			t.Fatal(err)
		}
		layout := forwarded.Document.WechatLayout
		if layout.Theme != theme || layout.Header == nil || *layout.Header || *layout.FontSize != 17 || forwarded.Document.Blocks[0].Card.Kind != "intro" || forwarded.Document.Blocks[0].Emphasis[0].Text != "工况" {
			t.Fatalf("layout was lost during CLI serialization: %s", data)
		}
	}
}

func TestWechatLayoutRejectsInvalidFields(t *testing.T) {
	for _, layout := range []string{`{"theme":"unknown"}`, `{"theme":"moyu-green","version":2}`, `{"theme":"moyu-green","fontSize":0}`, `{"theme":"moyu-green","lineHeight":8}`, `{"theme":"moyu-green","paragraphSpacing":1}`, `{"theme":"moyu-green","style":"color:red"}`} {
		input, err := readFillInput(nil, strings.NewReader(`{"document":{"title":"标题","blocks":[{"type":"paragraph","text":"正文"}],"wechatLayout":`+layout+`}}`))
		if err == nil && validateDocument(input.Document) == nil {
			t.Fatalf("accepted invalid layout: %s", layout)
		}
	}
	input, err := readFillInput(nil, strings.NewReader(`{"document":{"title":"标题","wechatLayout":{"theme":"moyu-green"},"blocks":[{"type":"paragraph","text":"正文","card":{"kind":"unknown"}}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if validateDocument(input.Document) == nil {
		t.Fatal("accepted invalid card")
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

func TestWechatDraftInputAndValidation(t *testing.T) {
	cover := filepath.Join(t.TempDir(), "cover.png")
	if err := os.WriteFile(cover, []byte("cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"wechat","document":{"title":"同一个选题的公众号版本","blocks":[{"type":"paragraph","text":"针对公众号读者的独立正文"},{"type":"image","materialId":"project-material","alt":"设备","caption":"项目图片"}]},"coverPath":%q,"platformOptions":{"wechat":{"author":"作者","expectedAppId":"wx1234567890abcdef"}}}`, cover)
	for _, tc := range []struct{ name, input, wantError string }{
		{"valid", base, ""},
		{"long title", strings.Replace(base, "同一个选题的公众号版本", strings.Repeat("长", 33), 1), "2-32"},
		{"title override", strings.Replace(base, `"wechat":{"author"`, `"wechat":{"title":"专用标题","author"`, 1), ""},
		{"empty override", strings.Replace(base, `"wechat":{"author"`, `"wechat":{"title":"","author"`, 1), "2-32"},
		{"author limit", strings.Replace(base, `"author":"作者"`, `"author":"`+strings.Repeat("字", 17)+`"`, 1), "16"},
		{"account binding", strings.Replace(base, "wx1234567890abcdef", "wrong-account", 1), "expectedAppId"},
		{"remote image", strings.Replace(base, `"materialId":"project-material"`, `"src":"https://example.com/image.png"`, 1), "materialId"},
		{"missing cover", strings.Replace(base, string(mustJSON(cover)), `""`, 1), "coverPath"},
		{"wrong platform options", strings.Replace(base, `"platform":"wechat"`, `"platform":"zhihu"`, 1), "只能用于微信公众号"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, err := readFillInput(nil, strings.NewReader(tc.input))
			if err != nil {
				t.Fatal(err)
			}
			err = validateFill(input)
			if tc.wantError == "" {
				if err != nil {
					t.Fatal(err)
				}
				if input.Document.Blocks[1].MaterialID != "project-material" || input.Document.Blocks[1].Caption != "项目图片" {
					t.Fatal("image fields lost")
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected %q, got %v", tc.wantError, err)
			}
		})
	}
}

func TestWechatPublishIsRejectedBeforeContactingDesktop(t *testing.T) {
	t.Setenv("GEO_PUBLISHER_USER_DATA_DIR", t.TempDir())
	path := filepath.Join(t.TempDir(), "input.json")
	for _, confirm := range []bool{false, true} {
		if err := os.WriteFile(path, mustJSON(fillInput{Platform: "wechat", ConfirmPublish: confirm}), 0o600); err != nil {
			t.Fatal(err)
		}
		_, _, err := run([]string{"publish", "--input", path})
		var typed *cliError
		if !errors.As(err, &typed) || typed.code != "WECHAT_DRAFT_ONLY" {
			t.Fatalf("expected draft-only rejection, got %v", err)
		}
	}
}

func TestWechatDiscoveryAndOfflineValidation(t *testing.T) {
	t.Setenv("GEO_PUBLISHER_USER_DATA_DIR", t.TempDir())
	var workflow struct {
		PlatformOrder      []string `json:"platformOrder"`
		DraftOnlyPlatforms []string `json:"draftOnlyPlatforms"`
	}
	if err := json.Unmarshal(instructions(), &workflow); err != nil {
		t.Fatal(err)
	}
	if len(workflow.PlatformOrder) != 7 || workflow.PlatformOrder[6] != "wechat" || len(workflow.DraftOnlyPlatforms) != 1 || workflow.DraftOnlyPlatforms[0] != "wechat" {
		t.Fatalf("unexpected platforms: %+v", workflow)
	}
	var schema struct {
		Article struct {
			Platform []string `json:"platform"`
		} `json:"article"`
		Commands map[string]struct {
			Platforms []string `json:"platforms"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(commandSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	if len(schema.Article.Platform) != 7 || len(schema.Commands["publish"].Platforms) != 6 {
		t.Fatal("schema lost draft/publish distinction")
	}
	for _, platform := range schema.Commands["publish"].Platforms {
		if platform == "wechat" {
			t.Fatal("wechat must not advertise publish")
		}
	}
	cover := filepath.Join(t.TempDir(), "cover.png")
	if err := os.WriteFile(cover, []byte("cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "article.json")
	title := "公众号专用标题"
	input := fillInput{ProjectID: "11111111-1111-4111-8111-111111111111", Platform: "wechat", CoverPath: cover,
		Document: articleDocument{Title: strings.Repeat("长", 33), Blocks: []articleBlock{{Type: "paragraph", Text: "正文"}}}, PlatformOptions: platformOptions{Wechat: &wechatOptions{Title: &title}}}
	if err := os.WriteFile(path, mustJSON(input), 0o600); err != nil {
		t.Fatal(err)
	}
	_, output, err := run([]string{"validate", "--input", path})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Title         string `json:"title"`
		CoverRequired bool   `json:"coverRequired"`
		DraftOnly     bool   `json:"draftOnly"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	if result.Title != title || !result.CoverRequired || !result.DraftOnly {
		t.Fatalf("incorrect validation: %+v", result)
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
	input, err := readFillInput(nil, strings.NewReader(`{"projectId":"11111111-1111-4111-8111-111111111111","platform":"toutiao","document":{"title":"正常标题","blocks":[{"type":"paragraph","text":"正文"}]},"coverPath":`+string(mustJSON(cover))+`}`))
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
