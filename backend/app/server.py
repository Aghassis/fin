"""Server entry point that listens on IPv4 and IPv6 at once.

SPEC sec. 2 promises the user opens http://localhost:8000. On a dual-stack host
"localhost" resolves to ::1 before 127.0.0.1, and Docker publishes the container
port on both families, forwarding the IPv6 side to the container's IPv6 address.
A listener on one family therefore accepts and immediately resets connections
from the other - which reads as a dead app rather than a wrong address family.

Passing --host :: is not enough: asyncio sets IPV6_V6ONLY on every AF_INET6
server socket it creates, so it would serve IPv6 alone. This binds the socket
first with IPV6_V6ONLY cleared and hands it to uvicorn.
"""

import os
import socket

import uvicorn

APP = "app.main:app"
DEFAULT_HOST = "::"
DEFAULT_PORT = 8000
BACKLOG = 2048


def bind_socket(host: str, port: int) -> socket.socket:
    """Bind a listening socket, dual-stack when the host supports IPv6.

    Falls back to IPv4 on kernels built without IPv6, where creating an
    AF_INET6 socket raises OSError.
    """
    if host in ("::", "::0", "[::]"):
        try:
            sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            host = "0.0.0.0"
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("::", port))
            sock.listen(BACKLOG)
            sock.set_inheritable(True)
            return sock

    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(BACKLOG)
    sock.set_inheritable(True)
    return sock


def main() -> None:
    host = os.environ.get("HOST", DEFAULT_HOST)
    port = int(os.environ.get("PORT", DEFAULT_PORT))
    sock = bind_socket(host, port)
    config = uvicorn.Config(APP, host=host, port=port)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
