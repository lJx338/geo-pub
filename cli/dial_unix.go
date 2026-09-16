//go:build !windows

package main

import (
	"context"
	"net"
)

func dialControl(ctx context.Context, endpoint string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
}
