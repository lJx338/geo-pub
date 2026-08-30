package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type discoveryRecord struct {
	CoreCLIPath string `json:"coreCliPath"`
	Ready       bool   `json:"ready"`
}

func main() {
	corePath, err := resolveCoreCLI()
	if err != nil {
		writeFailure("CORE_CLI_UNAVAILABLE", err.Error(), "打开 GEO Publisher Desktop，等待其完成更新后重试")
		os.Exit(1)
	}
	command := exec.Command(corePath, os.Args[1:]...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = os.Environ()
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		writeFailure("CORE_CLI_START_FAILED", err.Error(), "确认 GEO Publisher Desktop 未被安全软件隔离后重试")
		os.Exit(1)
	}
}

func resolveCoreCLI() (string, error) {
	data, err := os.ReadFile(discoveryPath())
	if err != nil {
		return "", fmt.Errorf("无法读取当前 GEO Publisher 连接信息：%w", err)
	}
	var discovery discoveryRecord
	if err := json.Unmarshal(data, &discovery); err != nil {
		return "", fmt.Errorf("当前 GEO Publisher 连接信息无效：%w", err)
	}
	if !discovery.Ready {
		return "", fmt.Errorf("GEO Publisher 正在启动或更新，请稍后重试")
	}
	if discovery.CoreCLIPath == "" {
		return "", fmt.Errorf("当前 GEO Publisher 版本不支持固定 CLI 启动器，请在桌面端点击“连接 WorkBuddy”后重试")
	}
	if !filepath.IsAbs(discovery.CoreCLIPath) || !insideDataDirectory(discovery.CoreCLIPath) {
		return "", fmt.Errorf("当前 Core CLI 路径不在 GEO Publisher 数据目录内")
	}
	info, err := os.Stat(discovery.CoreCLIPath)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("找不到当前 Core CLI：%s", discovery.CoreCLIPath)
	}
	return discovery.CoreCLIPath, nil
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

func discoveryPath() string { return filepath.Join(dataDirectory(), "discovery.json") }

func insideDataDirectory(path string) bool {
	relative, err := filepath.Rel(dataDirectory(), path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) && !filepath.IsAbs(relative)
}

func writeFailure(code string, message string, suggestion string) {
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok": false, "command": "launcher", "code": code, "message": message, "suggestion": suggestion,
	})
}
