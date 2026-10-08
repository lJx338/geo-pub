//go:build windows

package main

import (
	"context"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
)

func dialControl(ctx context.Context, endpoint string) (net.Conn, error) {
	if strings.HasPrefix(endpoint, "tcp:") {
		return dialLoopback(ctx, endpoint)
	}
	return winio.DialPipeContext(ctx, endpoint)
}
