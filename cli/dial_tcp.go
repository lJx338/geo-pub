package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
)

func loopbackAddress(endpoint string) (string, bool) {
	const prefix = "tcp://127.0.0.1:"
	if !strings.HasPrefix(endpoint, prefix) {
		return "", false
	}
	portText := strings.TrimPrefix(endpoint, prefix)
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 || strconv.Itoa(port) != portText {
		return "", false
	}
	return "127.0.0.1:" + portText, true
}

func dialLoopback(ctx context.Context, endpoint string) (net.Conn, error) {
	address, valid := loopbackAddress(endpoint)
	if !valid {
		return nil, fmt.Errorf("invalid local TCP control endpoint")
	}
	return (&net.Dialer{}).DialContext(ctx, "tcp", address)
}
