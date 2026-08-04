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
	version         = "0.1.0-alpha.1"
	defaultTimeout  = 15 * time.Second
	publishTimeout  = 4 * time.Minute
	maxResponseSize = 5 * 1024 * 1024
)

var platforms = map[string]bool{
	"baijia": true, "toutiao": true, "zhihu": true,
	"penguin": true, "sohu": true, "netease": true,
}

type controlRequest struct {
	ID        string `json:"id"`
	Token     string `json:"token"`
	Action    string `json:"action"`
	Platform  string `json:"platform,omitempty"`
	Title     string `json:"title,omitempty"`
	HTML      string `json:"html,omitempty"`
	CoverPath string `json:"coverPath"`
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
	Platform  string `json:"platform"`
	Title     string `json:"title"`
	HTML      string `json:"html"`
	CoverPath string `json:"coverPath"`
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
	case "fill":
		input, err := readFillInput(args, os.Stdin)
		if err != nil {
			return command, nil, err
		}
		if err := validateFill(input); err != nil {
			return command, nil, err
		}
		return call(command, controlRequest{
			Action: "draft.fill", Platform: input.Platform, Title: input.Title,
			HTML: input.HTML, CoverPath: input.CoverPath,
		}, publishTimeout)
	case "doctor":
		return command, doctor(), nil
	default:
		return command, nil, usageError("命令：start | status | show | open <platform> | login <platform> | inspect <platform> | fill [--input file.json] | doctor | version")
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
		return fillInput{}, usageError("fill 仅支持 --input <file.json>；不传时从 stdin 读取 JSON")
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
		return fillInput{}, &cliError{code: "INVALID_INPUT_JSON", message: err.Error(), suggestion: "字段应为 platform、title、html、coverPath"}
	}
	return input, nil
}

func validateFill(input fillInput) error {
	if input.Platform != "toutiao" && input.Platform != "baijia" && input.Platform != "zhihu" {
		return usageError("当前 alpha 版 fill 仅支持 platform=toutiao、platform=baijia 或 platform=zhihu")
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
	if input.Platform != "zhihu" && !filepath.IsAbs(input.CoverPath) {
		return usageError("coverPath 必须是绝对路径")
	}
	if input.Platform != "zhihu" {
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
		path := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "GEO Publisher", "GEO Publisher.exe")
		command = exec.Command(path)
	default:
		command = exec.Command("geo-publisher-desktop")
	}
	if err := command.Start(); err != nil {
		return &cliError{code: "DESKTOP_START_FAILED", message: err.Error(), suggestion: "确认 GEO Publisher 桌面端已安装"}
	}
	return nil
}

func doctor() json.RawMessage {
	result := map[string]any{
		"cliVersion":      version,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"dataDirectory":   dataDirectory(),
		"controlEndpoint": controlEndpoint(),
		"tokenFile":       tokenPath(),
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

func tokenPath() string { return filepath.Join(dataDirectory(), "control-token.json") }

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
