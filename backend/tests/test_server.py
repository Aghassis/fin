"""Tests for the listening socket the container serves on."""

import socket

import pytest

from app.server import bind_socket


def _has_ipv6() -> bool:
    if not socket.has_ipv6:
        return False
    try:
        socket.socket(socket.AF_INET6, socket.SOCK_STREAM).close()
    except OSError:
        return False
    return True


needs_ipv6 = pytest.mark.skipif(not _has_ipv6(), reason="host has no IPv6")


@needs_ipv6
def test_dual_stack_socket_accepts_both_families():
    """Both 127.0.0.1 and ::1 must reach the app: "localhost" can be either."""
    sock = bind_socket("::", 0)
    try:
        assert sock.family == socket.AF_INET6
        assert sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 0

        port = sock.getsockname()[1]
        for family, address in (
            (socket.AF_INET, ("127.0.0.1", port)),
            (socket.AF_INET6, ("::1", port)),
        ):
            with socket.socket(family, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(address)
    finally:
        sock.close()


def test_explicit_ipv4_host_binds_ipv4_only():
    """HOST=0.0.0.0 stays an escape hatch for kernels built without IPv6."""
    sock = bind_socket("0.0.0.0", 0)
    try:
        assert sock.family == socket.AF_INET
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(("127.0.0.1", sock.getsockname()[1]))
    finally:
        sock.close()
