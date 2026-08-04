//go:build windows

package main

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialControl(ctx context.Context, endpoint string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, endpoint)
}
