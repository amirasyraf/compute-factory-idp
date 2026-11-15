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
trap 'rmdir "$root/.build-lock"' EXIT
export NODE_OPTIONS='--no-node-snapshot --max-old-space-size=3072'
export CARGO_BUILD_JOBS=2
export RAYON_NUM_THREADS=2
export MAKEFLAGS=-j2
mise exec -- node .yarn/releases/yarn-4.13.0.cjs install --immutable
mise exec -- node .yarn/releases/yarn-4.13.0.cjs tsc
# Runtime app-backend injects the production frontend configuration. The build
# needs no login credentials, PAT, CA or production database password.
GITHUB_TOKEN=build-only mise exec -- node .yarn/releases/yarn-4.13.0.cjs build:backend
docker buildx build --platform linux/arm64 --load -t compute-factory-idp:latest .
ssh_opts=(-i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
target="ubuntu@$host"
ssh "${ssh_opts[@]}" "$target" 'mkdir -p /opt/idp && chmod 700 /opt/idp'
docker save compute-factory-idp:latest | ssh "${ssh_opts[@]}" "$target" 'docker load'
scp "${ssh_opts[@]}" deploy/docker-compose.yml deploy/Caddyfile "$target:/opt/idp/"
# Feed the env over stdin, creating it with restrictive permissions from the start.
ssh "${ssh_opts[@]}" "$target" 'umask 077; cat > /opt/idp/.env' < "$env_file"
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose up -d --remove-orphans'
