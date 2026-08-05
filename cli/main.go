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
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	defaultTimeout  = 15 * time.Second
	publishTimeout  = 4 * time.Minute
	maxResponseSize = 5 * 1024 * 1024
)

var version = "0.1.0-beta.4"

var platforms = map[string]bool{
	"baijia": true, "toutiao": true, "zhihu": true,
	"penguin": true, "sohu": true, "netease": true,
}

type controlRequest struct {
	ID             string   `json:"id"`
	Token          string   `json:"token"`
	Action         string   `json:"action"`
	Platform       string   `json:"platform,omitempty"`
	Title          string   `json:"title,omitempty"`
	HTML           string   `json:"html,omitempty"`
	CoverPath      string   `json:"coverPath"`
	Tags           []string `json:"tags"`
	ConfirmPublish bool     `json:"confirmPublish,omitempty"`
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
	Platform       string   `json:"platform"`
	Title          string   `json:"title"`
	HTML           string   `json:"html"`
	CoverPath      string   `json:"coverPath"`
	Tags           []string `json:"tags"`
	ConfirmPublish bool     `json:"confirmPublish,omitempty"`
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
		return call(command, controlRequest{Action: action, Platform: args[0]}, defaultTimeout)
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
				"valid": true, "platform": input.Platform, "title": input.Title,
				"titleLength": len([]rune(input.Title)), "htmlLength": len(input.HTML),
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
			Action: action, Platform: input.Platform, Title: input.Title,
			HTML: input.HTML, CoverPath: input.CoverPath, Tags: input.Tags, ConfirmPublish: input.ConfirmPublish,
		}, publishTimeout)
	case "doctor":
		return command, doctor(), nil
	default:
		return command, nil, usageError("命令：discover | doctor | instructions --json | schema --json | platforms | start | status | show | open <platform> | login <platform> | inspect <platform> | validate/fill/publish [--input file.json] | version")
	}
}

func call(command string, request controlRequest, timeout time.Duration) (string, json.RawMessage, error) {
	response, err := send(request, timeout)
	if err != nil {
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
		return fillInput{}, &cliError{code: "INVALID_INPUT_JSON", message: err.Error(), suggestion: "字段应为 platform、title、html、coverPath、tags（可选）、confirmPublish（publish 必须为 true）"}
	}
	if input.Tags == nil {
		input.Tags = []string{}
	}
	return input, nil
}

func validateFill(input fillInput) error {
	if input.Platform != "toutiao" && input.Platform != "baijia" && input.Platform != "zhihu" && input.Platform != "penguin" && input.Platform != "sohu" && input.Platform != "netease" {
		return usageError("当前 alpha 版 fill 支持 platform=toutiao、baijia、zhihu、penguin、sohu 或 netease")
	}
	if len([]rune(strings.TrimSpace(input.Title))) < 2 || len([]rune(input.Title)) > 64 {
		return usageError("title 必须为 2-64 个字符")
	}
	if input.Platform == "toutiao" && len([]rune(input.Title)) > 30 {
		return usageError("头条号 title 不能超过 30 个字符")
	}
	if strings.TrimSpace(input.HTML) == "" {
		return usageError("html 必填")
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
		command = exec.Command("open", "-a", "GEO Publisher")
	case "windows":
		path := windowsDesktopExecutable()
		if path == "" {
			return &cliError{code: "DESKTOP_START_FAILED", message: "找不到 GEO Publisher.exe", suggestion: "请手动打开一次 GEO Publisher，随后 CLI 会从 discovery.json 记住实际安装位置"}
		}
		command = exec.Command(path)
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
			"validate": map[string]any{"input": "article", "sideEffect": false},
			"fill":     map[string]any{"input": "article", "sideEffect": "overwrites the current draft but does not publish"},
			"publish":  map[string]any{"input": "article with confirmPublish=true", "sideEffect": "real external publication"},
		},
		"article": map[string]any{
			"platform":       []string{"baijia", "toutiao", "zhihu", "penguin", "sohu", "netease"},
			"title":          "string, 2-64 characters; Toutiao maximum 30",
			"html":           "non-empty HTML string",
			"coverPath":      "absolute local path; required for baijia, toutiao, netease",
			"tags":           "optional array, maximum 20",
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
	home, _ := os.UserHomeDir()
	sum := sha256.Sum256([]byte(home))
	key := hex.EncodeToString(sum[:])[:12]
	if runtime.GOOS == "windows" {
		return `\\.\pipe\geo-publisher-` + key
	}
	return "/tmp/geo-publisher-" + key + ".sock"
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
