package main

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestMASLoopbackEndpoint(t *testing.T) {
	for _, endpoint := range []string{"tcp://127.0.0.1:1", "tcp://127.0.0.1:65535"} {
		if _, ok := loopbackAddress(endpoint); !ok {
			t.Fatalf("rejected %q", endpoint)
		}
		if !validDiscoveredControlEndpointForOS(endpoint, "darwin") {
			t.Fatalf("discovery rejected %q", endpoint)
		}
	}
	for _, endpoint := range []string{"tcp://localhost:3000", "tcp://192.168.1.1:3000", "tcp://127.0.0.1:0", "tcp://127.0.0.1:65536", "tcp://127.0.0.1:03000", "tcp://127.0.0.1:3000/path", "tcp://127.0.0.1:+3000"} {
		if _, ok := loopbackAddress(endpoint); ok {
			t.Fatalf("accepted unsafe endpoint %q", endpoint)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := dialControl(ctx, "tcp://"+listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
