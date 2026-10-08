//go:build !windows

package main

import (
	"context"
	"net"
	"strings"
)

func dialControl(ctx context.Context, endpoint string) (net.Conn, error) {
	if strings.HasPrefix(endpoint, "tcp:") {
		return dialLoopback(ctx, endpoint)
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
}
