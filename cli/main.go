package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	defaultTimeout  = 15 * time.Second
	platformTimeout = 150 * time.Second
	publishTimeout  = 4 * time.Minute
	maxResponseSize = 5 * 1024 * 1024
)

var version = "0.5.0-beta.1"

var platforms = map[string]bool{
	"baijia": true, "toutiao": true, "zhihu": true,
	"penguin": true, "sohu": true, "netease": true,
}

type controlRequest struct {
	ID             string          `json:"id"`
	Token          string          `json:"token"`
	Action         string          `json:"action"`
	Platform       string          `json:"platform,omitempty"`
	ProjectID      string          `json:"projectId,omitempty"`
	Project        json.RawMessage `json:"project,omitempty"`
	Document       articleDocument `json:"document,omitempty"`
	CoverPath      string          `json:"coverPath"`
	ConfirmPublish bool            `json:"confirmPublish,omitempty"`
}

type controlResponse struct {
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details,omitempty"`
	} `json:"error,omitempty"`
}

type fillInput struct {
	ProjectID      string          `json:"projectId"`
	Platform       string          `json:"platform"`
	Document       articleDocument `json:"document"`
	CoverPath      string          `json:"coverPath"`
	ConfirmPublish bool            `json:"confirmPublish,omitempty"`
}

type articleDocument struct {
	Title   string         `json:"title"`
	Blocks  []articleBlock `json:"blocks"`
	Summary string         `json:"summary,omitempty"`
	Tags    []string       `json:"tags,omitempty"`
}

type articleBlock struct {
	Type    string   `json:"type"`
	Level   int      `json:"level,omitempty"`
	Text    string   `json:"text,omitempty"`
	Ordered bool     `json:"ordered,omitempty"`
	Items   []string `json:"items,omitempty"`
	Src     string   `json:"src,omitempty"`
	Alt     string   `json:"alt,omitempty"`
}

type cliOutput struct {
	OK         bool            `json:"ok"`
	Command    string          `json:"command,omitempty"`
	Version    string          `json:"version,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
	Code       string          `json:"code,omitempty"`
	Message    string          `json:"message,omitempty"`
	Suggestion string          `json:"suggestion,omitempty"`
	Details    json.RawMessage `json:"details,omitempty"`
}

type cliError struct {
	code       string
	message    string
	suggestion string
	details    json.RawMessage
}

func (e *cliError) Error() string { return e.message }

func main() {
	command, response, err := run(os.Args[1:])
	if err != nil {
		failure := cliOutput{OK: false, Command: command, Version: version, Code: "GEO_CLI_FAILED", Message: err.Error()}
		var typed *cliError
		if errors.As(err, &typed) {
			failure.Code = typed.code
			failure.Suggestion = typed.suggestion
			failure.Details = typed.details
		}
		writeJSON(os.Stderr, failure)
		os.Exit(1)
	}
	writeJSON(os.Stdout, cliOutput{OK: true, Command: command, Version: version, Data: response})
}

func run(args []string) (string, json.RawMessage, error) {
	command := "status"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}

	switch command {
	case "version", "--version", "-v":
		return "version", mustJSON(map[string]string{"version": version}), nil
	case "discover":
		return command, readDiscovery(), nil
	case "instructions":
		return command, instructions(), nil
	case "schema":
		return command, commandSchema(), nil
	case "platforms":
		return command, platformOverview(), nil
	case "start":
		if err := startDesktop(); err != nil {
			return command, nil, err
		}
		response, err := waitForDesktop(30 * time.Second)
		return command, response, err
	case "status":
		return call(command, controlRequest{Action: "status"}, defaultTimeout)
	case "projects":
		return call(command, controlRequest{Action: "project.list"}, defaultTimeout)
	case "project":
		return runProject(args)
	case "show":
		return call(command, controlRequest{Action: "app.show"}, defaultTimeout)
	case "open", "login", "inspect":
		if len(args) != 1 || !platforms[args[0]] {
			return command, nil, usageError("平台必须是 baijia、toutiao、zhihu、penguin、sohu 或 netease")
		}
		action := "platform.open"
		if command == "inspect" {
			action = "platform.inspect"
		}
		// Platform pages, especially NetEase on Windows, can legitimately take well
		// over 15 seconds to finish a cold load. Keep the short timeout for status
		// calls, but do not turn a slow page into a misleading connection failure.
		return call(command, controlRequest{Action: action, Platform: args[0]}, platformTimeout)
	case "validate", "fill", "publish":
		input, err := readFillInput(args, os.Stdin)
		if err != nil {
			return command, nil, err
		}
		if err := validateFill(input); err != nil {
			return command, nil, err
		}
		if command == "validate" {
			return command, mustJSON(map[string]any{
				"valid": true, "projectId": input.ProjectID, "platform": input.Platform, "title": input.Document.Title,
				"titleLength": len([]rune(input.Document.Title)), "blockCount": len(input.Document.Blocks),
				"coverRequired": input.Platform == "baijia" || input.Platform == "toutiao" || input.Platform == "netease",
			}), nil
		}
		if command == "publish" && !input.ConfirmPublish {
			return command, nil, usageError("真实发布必须在 JSON 中显式设置 confirmPublish=true")
		}
		action := "draft.fill"
		if command == "publish" {
			action = "draft.publish"
		}
		return call(command, controlRequest{
			Action: action, ProjectID: input.ProjectID, Platform: input.Platform, Document: input.Document,
			CoverPath: input.CoverPath, ConfirmPublish: input.ConfirmPublish,
		}, publishTimeout)
	case "doctor":
		return command, doctor(), nil
	default:
		return command, nil, usageError("命令：discover | doctor | projects | project current|select|create|update|archive | instructions --json | schema --json | platforms | start | status | show | open <platform> | login <platform> | inspect <platform> | validate/fill/publish [--input file.json] | version")
	}
}

func runProject(args []string) (string, json.RawMessage, error) {
	if len(args) == 0 {
		return "project", nil, usageError("项目命令：project current | select <projectId> | create/import --input <file.json> | update <projectId> --input <file.json> | export <projectId> --output <file.json> | archive <projectId>")
	}
	subcommand := args[0]
	switch subcommand {
	case "current":
		_, data, err := call("project.current", controlRequest{Action: "project.current"}, defaultTimeout)
		return "project.current", data, err
	case "select", "archive":
		if len(args) != 2 {
			return "project." + subcommand, nil, usageError("请提供 projectId")
		}
		action := "project.select"
		if subcommand == "archive" {
			action = "project.archive"
		}
		_, data, err := call("project."+subcommand, controlRequest{Action: action, ProjectID: args[1]}, defaultTimeout)
		return "project." + subcommand, data, err
	case "export":
		if len(args) != 4 || args[2] != "--output" {
			return "project.export", nil, usageError("请使用 project export <projectId> --output <file.json>")
		}
		_, data, err := call("project.get", controlRequest{Action: "project.get", ProjectID: args[1]}, defaultTimeout)
		if err != nil {
			return "project.export", nil, err
		}
		var result struct {
			Project json.RawMessage `json:"project"`
		}
		if json.Unmarshal(data, &result) != nil || len(result.Project) == 0 || string(result.Project) == "null" {
			return "project.export", nil, &cliError{code: "PROJECT_NOT_FOUND", message: "找不到客户项目", suggestion: "运行 geo-publisher projects 查看可用项目"}
		}
		if err := os.WriteFile(args[3], append(result.Project, '\n'), 0o600); err != nil {
			return "project.export", nil, &cliError{code: "PROJECT_EXPORT_FAILED", message: err.Error(), suggestion: "检查导出目录是否可写"}
		}
		return "project.export", mustJSON(map[string]any{"output": args[3]}), nil
	case "create", "import", "update":
		projectID, remaining := "", args[1:]
		if subcommand == "update" {
			if len(remaining) < 1 {
				return "project.update", nil, usageError("请提供 projectId")
			}
			projectID, remaining = remaining[0], remaining[1:]
		}
		flags := flag.NewFlagSet("project "+subcommand, flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		inputPath := flags.String("input", "", "JSON project file")
		if err := flags.Parse(remaining); err != nil || *inputPath == "" {
			return "project." + subcommand, nil, usageError("请使用 --input <项目资料.json>")
		}
		data, err := os.ReadFile(*inputPath)
		if err != nil {
			return "project." + subcommand, nil, &cliError{code: "INPUT_READ_FAILED", message: err.Error(), suggestion: "检查项目资料 JSON 文件路径"}
		}
		var project map[string]any
		if err := json.Unmarshal(data, &project); err != nil {
			return "project." + subcommand, nil, usageError("项目资料必须是有效 JSON 对象")
		}
		action := "project.create"
		if subcommand == "update" {
			action = "project.update"
		}
		_, result, err := call("project."+subcommand, controlRequest{Action: action, ProjectID: projectID, Project: data}, defaultTimeout)
		return "project." + subcommand, result, err
	default:
		return "project", nil, usageError("项目命令：project current | select <projectId> | create/import --input <file.json> | update <projectId> --input <file.json> | export <projectId> --output <file.json> | archive <projectId>")
	}
}

func call(command string, request controlRequest, timeout time.Duration) (string, json.RawMessage, error) {
	response, err := send(request, timeout)
	if err != nil {
		var typed *cliError
		if errors.As(err, &typed) && typed.code == "CONTROL_READ_TIMEOUT" && (command == "fill" || command == "publish") {
			return command, nil, &cliError{
				code:       typed.code,
				message:    "桌面端 4 分钟内尚未返回结果，网络可能过慢，原任务也可能仍在执行",
				suggestion: "先检查网络，不要立即重复发布；运行 geo-publisher status，待 busy=false 后再 inspect 对应平台",
			}
		}
		return command, nil, err
	}
	return command, response, nil
}

func send(request controlRequest, timeout time.Duration) (json.RawMessage, error) {
	token, err := readToken()
	if err != nil {
		return nil, err
	}
	request.ID = randomID()
	request.Token = token

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	connection, err := dialControl(ctx, controlEndpoint())
	if err != nil {
		return nil, &cliError{
			code: "DESKTOP_NOT_RUNNING", message: "无法连接 GEO Publisher 桌面端：" + err.Error(),
			suggestion: "先打开 GEO Publisher，或运行 geo-publisher start",
		}
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(timeout))
	payload, _ := json.Marshal(request)
	if _, err := connection.Write(append(payload, '\n')); err != nil {
		return nil, &cliError{code: "CONTROL_WRITE_FAILED", message: err.Error(), suggestion: "确认桌面端仍在运行后重试"}
	}

	reader := bufio.NewReader(io.LimitReader(connection, maxResponseSize+1))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			return nil, &cliError{
				code:       "CONTROL_READ_TIMEOUT",
				message:    "桌面端在当前命令的等待时间内尚未返回，网络可能过慢",
				suggestion: "先检查网络，再确认桌面端当前状态",
			}
		}
		return nil, &cliError{code: "CONTROL_READ_FAILED", message: err.Error(), suggestion: "检查桌面端日志后重试"}
	}
	if len(line) > maxResponseSize {
		return nil, &cliError{code: "CONTROL_RESPONSE_TOO_LARGE", message: "桌面端响应超过 5MB"}
	}
	var response controlResponse
	if err := json.Unmarshal(line, &response); err != nil {
		return nil, &cliError{code: "INVALID_CONTROL_RESPONSE", message: "桌面端返回了无法解析的数据：" + err.Error()}
	}
	if !response.OK {
		if response.Error == nil {
			return nil, &cliError{code: "CONTROL_REQUEST_FAILED", message: "桌面端请求失败，但未返回错误详情"}
		}
		return nil, &cliError{
			code: response.Error.Code, message: response.Error.Message,
			suggestion: suggestionFor(response.Error.Code), details: response.Error.Details,
		}
	}
	return response.Data, nil
}

func readFillInput(args []string, stdin io.Reader) (fillInput, error) {
	flags := flag.NewFlagSet("fill", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	inputPath := flags.String("input", "", "JSON request file")
	if err := flags.Parse(args); err != nil {
		return fillInput{}, usageError("validate/fill/publish 仅支持 --input <file.json>；不传时从 stdin 读取 JSON")
	}
	var data []byte
	var err error
	if *inputPath != "" {
		data, err = os.ReadFile(*inputPath)
	} else {
		data, err = io.ReadAll(io.LimitReader(stdin, maxResponseSize+1))
	}
	if err != nil {
		return fillInput{}, &cliError{code: "INPUT_READ_FAILED", message: err.Error(), suggestion: "检查 JSON 文件路径和读取权限"}
	}
	if len(data) == 0 {
		return fillInput{}, usageError("请通过 stdin 传入 JSON，或使用 --input <file.json>")
	}
	if len(data) > maxResponseSize {
		return fillInput{}, &cliError{code: "INPUT_TOO_LARGE", message: "输入超过 5MB"}
	}
	var input fillInput
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return fillInput{}, &cliError{code: "INVALID_INPUT_JSON", message: err.Error(), suggestion: "字段应为 projectId、platform、document、coverPath（可选）、confirmPublish（publish 必须为 true）"}
	}
	if input.Document.Tags == nil {
		input.Document.Tags = []string{}
	}
	return input, nil
}

func validateFill(input fillInput) error {
	if len(strings.TrimSpace(input.ProjectID)) != 36 {
		return usageError("projectId 必须来自 geo-publisher project current")
	}
	if input.Platform != "toutiao" && input.Platform != "baijia" && input.Platform != "zhihu" && input.Platform != "penguin" && input.Platform != "sohu" && input.Platform != "netease" {
		return usageError("当前 alpha 版 fill 支持 platform=toutiao、baijia、zhihu、penguin、sohu 或 netease")
	}
	if err := validateDocument(input.Document); err != nil {
		return err
	}
	titleLength := len([]rune(strings.TrimSpace(input.Document.Title)))
	if input.Platform == "toutiao" && titleLength > 30 {
		return usageError("头条号 document.title 不能超过 30 个字符")
	}
	if input.Platform == "baijia" && titleLength > 64 {
		return usageError("百家号 document.title 不能超过 64 个字符")
	}
	if input.Platform == "sohu" && (titleLength < 5 || titleLength > 72) {
		return usageError("搜狐号 document.title 必须为 5-72 个字符")
	}
	if input.Platform == "netease" && (titleLength < 5 || titleLength > 64) {
		return usageError("网易号 document.title 必须为 5-64 个字符")
	}
	if input.Platform != "zhihu" && input.Platform != "penguin" && input.Platform != "sohu" && !filepath.IsAbs(input.CoverPath) {
		return usageError("coverPath 必须是绝对路径")
	}
	if input.Platform != "zhihu" && input.Platform != "penguin" && input.Platform != "sohu" {
		info, err := os.Stat(input.CoverPath)
		if err != nil || info.IsDir() {
			return &cliError{code: "COVER_NOT_FOUND", message: "找不到封面文件：" + input.CoverPath, suggestion: "传入当前电脑上的封面绝对路径"}
		}
	}
	return nil
}

func validateDocument(document articleDocument) error {
	if len([]rune(strings.TrimSpace(document.Title))) < 2 || len([]rune(document.Title)) > 100 {
		return usageError("document.title 必须为 2-100 个字符")
	}
	if len(document.Blocks) == 0 || len(document.Blocks) > 120 {
		return usageError("document.blocks 必须包含 1-120 个正文块")
	}
	if len([]rune(document.Summary)) > 120 {
		return usageError("document.summary 不能超过 120 个字符")
	}
	if len(document.Tags) > 9 {
		return usageError("document.tags 最多 9 个")
	}
	for index, block := range document.Blocks {
		switch block.Type {
		case "paragraph", "quote":
			if strings.TrimSpace(block.Text) == "" {
				return usageError(fmt.Sprintf("document.blocks[%d].text 不能为空", index))
			}
		case "heading":
			if strings.TrimSpace(block.Text) == "" || (block.Level != 2 && block.Level != 3) {
				return usageError(fmt.Sprintf("document.blocks[%d] 只能使用 level=2 或 level=3 的小标题", index))
			}
		case "list":
			if len(block.Items) == 0 || len(block.Items) > 30 {
				return usageError(fmt.Sprintf("document.blocks[%d].items 必须包含 1-30 项", index))
			}
			for _, item := range block.Items {
				if strings.TrimSpace(item) == "" {
					return usageError(fmt.Sprintf("document.blocks[%d].items 不能包含空项", index))
				}
			}
		case "divider":
		case "image":
			if !strings.HasPrefix(block.Src, "https://") && !strings.HasPrefix(block.Src, "http://") {
				return usageError(fmt.Sprintf("document.blocks[%d].src 必须是 http(s) 图片地址", index))
			}
		default:
			return usageError(fmt.Sprintf("document.blocks[%d].type 不支持：%s", index, block.Type))
		}
	}
	return nil
}

func waitForDesktop(timeout time.Duration) (json.RawMessage, error) {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		response, err := send(controlRequest{Action: "status"}, 2*time.Second)
		if err == nil {
			return response, nil
		}
		last = err
		time.Sleep(500 * time.Millisecond)
	}
	return nil, &cliError{code: "DESKTOP_START_TIMEOUT", message: fmt.Sprintf("桌面端 30 秒内没有就绪：%v", last), suggestion: "手动打开 GEO Publisher 并查看是否有系统拦截提示"}
}

func startDesktop() error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", "-g", "-a", "GEO Publisher", "--args", "--background")
	case "windows":
		path := windowsDesktopExecutable()
		if path == "" {
			return &cliError{code: "DESKTOP_START_FAILED", message: "找不到 GEO Publisher.exe", suggestion: "请手动打开一次 GEO Publisher，随后 CLI 会从 discovery.json 记住实际安装位置"}
		}
		command = exec.Command(path, "--background")
	default:
		command = exec.Command("geo-publisher-desktop")
	}
	if err := command.Start(); err != nil {
		return &cliError{code: "DESKTOP_START_FAILED", message: err.Error(), suggestion: "确认 GEO Publisher 桌面端已安装"}
	}
	return nil
}

func desktopPathFromDiscovery(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var record struct {
		AppPath string `json:"appPath"`
	}
	if json.Unmarshal(data, &record) != nil || record.AppPath == "" {
		return ""
	}
	if info, err := os.Stat(record.AppPath); err == nil && !info.IsDir() {
		return record.AppPath
	}
	return ""
}

func windowsDesktopExecutable() string {
	if path := desktopPathFromDiscovery(discoveryPath()); path != "" {
		return path
	}
	local := os.Getenv("LOCALAPPDATA")
	for _, directory := range []string{"GEO Publisher", "geo-publisher-desktop"} {
		candidate := filepath.Join(local, "Programs", directory, "GEO Publisher.exe")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	programs := filepath.Join(local, "Programs")
	found := ""
	_ = filepath.Walk(programs, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if strings.EqualFold(info.Name(), "GEO Publisher.exe") {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

func doctor() json.RawMessage {
	result := map[string]any{
		"cliVersion":      version,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"dataDirectory":   dataDirectory(),
		"controlEndpoint": controlEndpoint(),
		"tokenFile":       tokenPath(),
		"discoveryFile":   discoveryPath(),
	}
	var discovery map[string]any
	if data, err := os.ReadFile(discoveryPath()); err == nil && json.Unmarshal(data, &discovery) == nil {
		result["discoveryReadable"] = true
		result["discovery"] = discovery
		if appVersion, ok := discovery["appVersion"].(string); ok {
			result["versionMatch"] = appVersion == version
		}
	} else {
		result["discoveryReadable"] = false
	}
	if _, err := os.Stat(tokenPath()); err == nil {
		result["tokenFileReadable"] = true
	} else {
		result["tokenFileReadable"] = false
		result["tokenFileError"] = err.Error()
	}
	if response, err := send(controlRequest{Action: "status"}, 2*time.Second); err == nil {
		result["desktopConnected"] = true
		result["desktop"] = json.RawMessage(response)
	} else {
		result["desktopConnected"] = false
		result["desktopError"] = err.Error()
	}
	return mustJSON(result)
}

func readDiscovery() json.RawMessage {
	data, err := os.ReadFile(discoveryPath())
	if err != nil {
		return mustJSON(map[string]any{"found": false, "path": discoveryPath(), "error": err.Error()})
	}
	var record any
	if err := json.Unmarshal(data, &record); err != nil {
		return mustJSON(map[string]any{"found": false, "path": discoveryPath(), "error": err.Error()})
	}
	return mustJSON(map[string]any{"found": true, "path": discoveryPath(), "record": record})
}

func instructions() json.RawMessage {
	return mustJSON(map[string]any{
		"version": version,
		"workflow": []string{
			"Run doctor and start the desktop when it is not connected",
			"Run project current and use its exact project.id for every article request",
			"Run validate with the exact article JSON",
			"Use fill for preview or any request that says not to publish",
			"Use publish only after explicit user authorization and confirmPublish=true",
			"Process platforms serially and preserve every structured result",
			"Never republish automatically when status=result_uncertain; reconcile first",
		},
		"platformOrder": []string{"baijia", "toutiao", "zhihu", "penguin", "sohu", "netease"},
		"platformNames": map[string]string{
			"百家号": "baijia", "头条号": "toutiao", "知乎": "zhihu",
			"企鹅号": "penguin", "搜狐号": "sohu", "网易号": "netease",
		},
	})
}

func commandSchema() json.RawMessage {
	return mustJSON(map[string]any{
		"commands": map[string]any{
			"doctor":   map[string]any{"input": nil, "sideEffect": false},
			"projects": map[string]any{"input": nil, "sideEffect": false},
			"project":  map[string]any{"input": "project profile JSON for create, import, or update", "sideEffect": "manages the selected customer project"},
			"validate": map[string]any{"input": "article", "sideEffect": false},
			"fill":     map[string]any{"input": "article", "sideEffect": "overwrites the current draft but does not publish"},
			"publish":  map[string]any{"input": "article with confirmPublish=true", "sideEffect": "real external publication"},
		},
		"article": map[string]any{
			"projectId": "required UUID from geo-publisher project current; must match the project currently selected in GEO Publisher",
			"platform": []string{"baijia", "toutiao", "zhihu", "penguin", "sohu", "netease"},
			"document": map[string]any{
				"title": "string; Toutiao 2-30, Baijia 2-64, Sohu 5-72, NetEase 5-64",
				"blocks": []map[string]any{
					{"type": "paragraph", "text": "string"},
					{"type": "heading", "level": "2 or 3", "text": "string"},
					{"type": "list", "ordered": "boolean", "items": "string[]"},
					{"type": "quote", "text": "string"},
					{"type": "divider"},
					{"type": "image", "src": "https:// image URL", "alt": "optional string"},
				},
				"summary": "optional string, maximum 120 characters",
				"tags":    "optional array, maximum 9",
			},
			"coverPath":      "absolute local path; required for baijia, toutiao, netease",
			"confirmPublish": "must be true for publish",
		},
	})
}

func platformOverview() json.RawMessage {
	names := map[string]string{
		"baijia": "百家号", "toutiao": "头条号", "zhihu": "知乎",
		"penguin": "企鹅号", "sohu": "搜狐号", "netease": "网易号",
	}
	result := map[string]any{"supported": names, "desktopConnected": false}
	if response, err := send(controlRequest{Action: "status"}, 2*time.Second); err == nil {
		result["desktopConnected"] = true
		result["desktop"] = json.RawMessage(response)
	} else {
		result["desktopError"] = err.Error()
	}
	return mustJSON(result)
}

func readToken() (string, error) {
	data, err := os.ReadFile(tokenPath())
	if err != nil {
		return "", &cliError{code: "CONTROL_TOKEN_MISSING", message: err.Error(), suggestion: "先启动一次 GEO Publisher 桌面端"}
	}
	var record struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &record); err != nil || len(record.Token) != 64 {
		return "", &cliError{code: "CONTROL_TOKEN_INVALID", message: "本地控制令牌无效", suggestion: "完全退出并重新启动 GEO Publisher"}
	}
	return record.Token, nil
}

func dataDirectory() string {
	if override := os.Getenv("GEO_PUBLISHER_USER_DATA_DIR"); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "GEO Publisher Desktop")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "GEO Publisher Desktop")
	default:
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "geo-publisher")
	}
}

func tokenPath() string     { return filepath.Join(dataDirectory(), "control-token.json") }
func discoveryPath() string { return filepath.Join(dataDirectory(), "discovery.json") }

func controlEndpoint() string {
	if override := os.Getenv("GEO_PUBLISHER_CONTROL_ENDPOINT"); override != "" {
		return override
	}
	if endpoint := controlEndpointFromDiscovery(discoveryPath()); endpoint != "" {
		return endpoint
	}
	home, _ := os.UserHomeDir()
	sum := sha256.Sum256([]byte(home))
	key := hex.EncodeToString(sum[:])[:12]
	if runtime.GOOS == "windows" {
		return `\\.\pipe\geo-publisher-` + key
	}
	return "/tmp/geo-publisher-" + key + ".sock"
}

func controlEndpointFromDiscovery(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var record struct {
		ControlEndpoint string `json:"controlEndpoint"`
	}
	if json.Unmarshal(data, &record) != nil || !validDiscoveredControlEndpoint(record.ControlEndpoint) {
		return ""
	}
	return record.ControlEndpoint
}

func validDiscoveredControlEndpoint(endpoint string) bool {
	return validDiscoveredControlEndpointForOS(endpoint, runtime.GOOS)
}

func validDiscoveredControlEndpointForOS(endpoint string, goos string) bool {
	var key string
	if goos == "windows" {
		key = strings.TrimPrefix(endpoint, `\\.\pipe\geo-publisher-`)
		if key == endpoint {
			return false
		}
	} else {
		key = strings.TrimSuffix(strings.TrimPrefix(endpoint, "/tmp/geo-publisher-"), ".sock")
		if "/tmp/geo-publisher-"+key+".sock" != endpoint {
			return false
		}
	}
	if len(key) != 12 {
		return false
	}
	for _, character := range key {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func randomID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func usageError(message string) error {
	return &cliError{code: "INVALID_ARGUMENT", message: message, suggestion: "运行 geo-publisher doctor 检查环境"}
}

func suggestionFor(code string) string {
	switch code {
	case "LOGIN_REQUIRED", "VERIFICATION_REQUIRED", "RISK_CONTROL_REQUIRED":
		return "GEO Publisher 已打开对应页面；请完成登录、验证或风险提示处理后重新执行同一命令一次"
	case "UNAUTHORIZED":
		return "完全退出并重新启动桌面端，再重试命令"
	case "CONTROL_REQUEST_FAILED":
		return "查看返回信息和桌面端错误提示；登录或验证码需在桌面端处理"
	default:
		return "保留完整 JSON 错误并交给 WorkBuddy 或技术支持处理"
	}
}

func mustJSON(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func writeJSON(writer io.Writer, value any) {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
}
