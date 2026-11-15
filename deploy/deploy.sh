#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "Usage: $0 <host> <env-file>" >&2; exit 2; fi
host=$1
env_file=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
[[ -r "$env_file" ]] || { echo 'Env file is not readable' >&2; exit 2; }
for key in IDP_DOMAIN IDP_USERS_B64 GITHUB_TOKEN POSTGRES_PASSWORD BACKSTAGE_TOKEN AWS_REGION SSH_CA_SECRET_ID; do
  grep -qE "^${key}=.+" "$env_file" || { echo "Missing env key: $key" >&2; exit 2; }
done
[[ "$host" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid host' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
# No concurrent local IDP builds; fail rather than wait on a shared laptop.
mkdir .build-lock 2>/dev/null || { echo 'An IDP build is already running' >&2; exit 1; }
lock="$root/.build-lock"
ssh_opts=(-i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
target="ubuntu@$host"
tsc_pid=""
cleanup() {
  [[ -n "$tsc_pid" ]] && kill "$tsc_pid" 2>/dev/null
  [[ -S "$lock/tunnel" ]] && ssh -S "$lock/tunnel" -O exit "$target" 2>/dev/null
  rm -rf "$lock"
}
trap cleanup EXIT
export NODE_OPTIONS='--no-node-snapshot --max-old-space-size=3072'
export CARGO_BUILD_JOBS=2
export RAYON_NUM_THREADS=2
export MAKEFLAGS=-j2
mise exec -- node .yarn/releases/yarn-4.13.0.cjs install --immutable
# Type check runs alongside the bundle build (separate processes); both must pass before shipping.
mise exec -- node .yarn/releases/yarn-4.13.0.cjs tsc >"$lock/tsc.log" 2>&1 &
tsc_pid=$!
# Runtime app-backend injects the production frontend configuration. The build
# needs no login credentials, PAT, CA or production database password.
GITHUB_TOKEN=build-only mise exec -- node .yarn/releases/yarn-4.13.0.cjs build:backend
wait "$tsc_pid" || { cat "$lock/tsc.log" >&2; echo 'Type check failed' >&2; exit 1; }
tsc_pid=""
# No provenance attestation: a single plain manifest keeps registry garbage collection simple.
docker buildx build --platform linux/arm64 --provenance=false --load -t compute-factory-idp:latest .
ssh "${ssh_opts[@]}" "$target" 'mkdir -p /opt/idp && chmod 700 /opt/idp'
scp "${ssh_opts[@]}" deploy/docker-compose.yml deploy/Caddyfile "$target:/opt/idp/"
# Feed the env over stdin, creating it with restrictive permissions from the start.
ssh "${ssh_opts[@]}" "$target" 'umask 077; cat > /opt/idp/.env' < "$env_file"
# Ship the image through a registry on the host (bound to 127.0.0.1 there) over an SSH tunnel.
# docker push uploads only the compressed layers the host lacks, not the whole image each time.
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose up -d registry' </dev/null
ssh "${ssh_opts[@]}" -M -S "$lock/tunnel" -o ExitOnForwardFailure=yes -f -N \
  -L 127.0.0.1:15000:127.0.0.1:15000 "$target"
for _ in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:15000/v2/ && break; sleep 1; done
docker tag compute-factory-idp:latest localhost:15000/compute-factory-idp:latest
docker push localhost:15000/compute-factory-idp:latest
ssh -S "$lock/tunnel" -O exit "$target" 2>/dev/null
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose pull backstage && docker compose up -d --remove-orphans' </dev/null
# A running Caddy does not re-read its bind-mounted Caddyfile; apply any change now.
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile' </dev/null
# Reclaim superseded layers: untagged registry blobs and images no longer used by a container.
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose exec -T registry bin/registry garbage-collect --delete-untagged /etc/docker/registry/config.yml >/dev/null && docker image prune -af >/dev/null' </dev/null
