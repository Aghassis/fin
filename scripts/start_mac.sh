#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="finally"
IMAGE_NAME="finally"
PORT=8000
URL="http://localhost:$PORT"
HEALTH="/api/health"

cd "$(dirname "$0")/.."

# Build if image doesn't exist or --build flag passed
if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Building image..."
    docker build -t "$IMAGE_NAME" .
fi

# Stop existing container if running (idempotent)
docker rm -f "$CONTAINER_NAME" &>/dev/null || true

run_container() {
    docker run -d \
        --name "$CONTAINER_NAME" \
        "$@" \
        -v finally-data:/app/db \
        --env-file .env \
        "$IMAGE_NAME"
}

# Publish on both address families so the printed URL resolves either way:
# "localhost" is ::1 first on a dual-stack host and 127.0.0.1 elsewhere.
# A daemon without IPv6 rejects the [::] mapping, so fall back to IPv4 only.
err_log="$(mktemp)"
trap 'rm -f "$err_log"' EXIT

if ! run_container -p "0.0.0.0:$PORT:8000" -p "[::]:$PORT:8000" >/dev/null 2>"$err_log"; then
    docker rm -f "$CONTAINER_NAME" &>/dev/null || true
    if run_container -p "0.0.0.0:$PORT:8000" >/dev/null 2>>"$err_log"; then
        echo "IPv6 port publishing unavailable; publishing on IPv4 only."
    else
        docker rm -f "$CONTAINER_NAME" &>/dev/null || true
        cat "$err_log" >&2
        exit 1
    fi
fi

# Reachability probe: a bind that silently fails must surface as an address
# problem here instead of as a blank page that reads like a dead app.
if ! command -v curl &>/dev/null; then
    echo "curl not found - skipping reachability probe."
    echo "FinAlly running at $URL"
    command -v open &>/dev/null && open "$URL"
    exit 0
fi

# Returns curl's exit status: 0 reachable, 6 no address of that family for
# "localhost" (nothing to fix), anything else a real connection failure.
probe() {
    curl "$1" -fs -m 3 -o /dev/null "$URL$HEALTH" 2>/dev/null
}

printf 'Waiting for FinAlly at %s' "$URL"
reachable=""
for _ in $(seq 1 30); do
    if probe -4 || probe -6; then
        reachable="yes"
        break
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" != "true" ]]; then
        printf '\n'
        echo "Container is not running. Recent logs:" >&2
        docker logs --tail 30 "$CONTAINER_NAME" >&2 || true
        exit 1
    fi
    printf '.'
    sleep 1
done
printf '\n'

if [[ -z "$reachable" ]]; then
    echo "FinAlly never answered at $URL. Recent logs:" >&2
    docker logs --tail 30 "$CONTAINER_NAME" >&2 || true
    exit 1
fi

# Both families must answer, or "localhost" works only by luck of resolution.
for family in -4 -6; do
    status=0
    probe "$family" || status=$?
    # 6 means "localhost" has no address of this family here - nothing to fix.
    if [[ $status -eq 0 || $status -eq 6 ]]; then
        continue
    fi
    echo "FinAlly answers on $URL over one address family but not the other" >&2
    echo "  (curl $family failed with exit $status). 'localhost' can resolve to either," >&2
    echo "  so the app will look dead to some clients. Check the published ports:" >&2
    docker port "$CONTAINER_NAME" >&2 || true
    exit 1
done

echo "FinAlly running at $URL"

# Open browser if on macOS
if command -v open &>/dev/null; then
    open "$URL"
fi
