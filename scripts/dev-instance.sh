#!/usr/bin/env bash
# Disposable Dokploy dev instance for the current checkout.
#
#   scripts/dev-instance.sh up       start Postgres, run migrations, start the dev server
#   scripts/dev-instance.sh status   show what is running
#   scripts/dev-instance.sh url      print the URL
#   scripts/dev-instance.sh logs     tail the dev server log
#   scripts/dev-instance.sh down     stop everything and delete all state
#
# This is the "lighter" path from CONTRIBUTING.md: it does NOT run
# `pnpm dokploy:setup`, so it never touches Docker Swarm, Traefik, the
# `dokploy-network` network or /etc/dokploy. The only Docker object it creates
# is one Postgres container. The app cannot deploy anything (no Swarm, no
# Traefik), but every page, API route and database migration works.
#
# Requirements: bash, Docker, Node (version in .nvmrc) and pnpm. Linux, macOS
# or WSL; not Windows without WSL.
#
# Everything is keyed on the checkout directory, so each git worktree gets its
# own instance and `up` is safe to run twice. One instance per checkout (the
# Next.js dev server locks its .next directory); use git worktrees to run several.
# Override with:
#   DEV_INSTANCE_NAME      instance name (default: <directory>-<hash of path>)
#   DEV_INSTANCE_PORT      first port to try for the app (default 3100)
#   DEV_INSTANCE_PG_PORT   first port to try for Postgres (default 55432)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

slug="$(basename "$ROOT" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-20)"
hash="$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1 | tail -c 7)"
NAME="${DEV_INSTANCE_NAME:-${slug:-dokploy}-$hash}"

CONTAINER="dokploy-dev-$NAME-postgres"
LABEL="dokploy.dev-instance=$NAME"
STATE_DIR="$ROOT/.dev-instance/$NAME"
STATE_FILE="$STATE_DIR/state.env"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
PG_IMAGE="postgres:16" # same image packages/server/src/setup/postgres-setup.ts uses

log() { printf '[dev-instance] %s\n' "$*"; }
die() { printf '[dev-instance] error: %s\n' "$*" >&2; exit 1; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

free_port() {
	local port="$1"
	while port_in_use "$port"; do port=$((port + 1)); done
	echo "$port"
}

container_exists() { docker inspect "$CONTAINER" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; }
server_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

load_state() {
	# shellcheck disable=SC1090
	. "$STATE_FILE"
}

url() { echo "http://127.0.0.1:$APP_PORT"; }

http_ok() {
	local code
	code="$(curl -s -o /dev/null -L -m 10 -w '%{http_code}' "$(url)/" || true)"
	[ "$code" = "200" ]
}

kill_tree() {
	local pid="$1" child
	for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
	kill "$pid" 2>/dev/null || true
}

check_prereqs() {
	command -v docker >/dev/null || die "docker is not installed"
	docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon"
	command -v pnpm >/dev/null || die "pnpm is not installed"
	command -v curl >/dev/null || die "curl is not installed"
	local want have
	want="$(tr -d '[:space:]v' <"$ROOT/.nvmrc")"
	have="$(node -v 2>/dev/null | tr -d '[:space:]v' || true)"
	[ "${have%%.*}" = "${want%%.*}" ] ||
		die "Node ${want%%.*}.x required (see .nvmrc), found '${have:-none}'. Run: nvm install $want && nvm use"
}

cmd_up() {
	check_prereqs
	mkdir -p "$STATE_DIR"

	if [ ! -f "$STATE_FILE" ]; then
		# Stale container from a lost state file: its password is unknown, so recreate.
		if container_exists; then docker rm -f -v "$CONTAINER" >/dev/null; fi
		umask 077
		local pg_port app_port password
		pg_port="$(free_port "${DEV_INSTANCE_PG_PORT:-55432}")"
		app_port="$(free_port "${DEV_INSTANCE_PORT:-3100}")"
		[ "$app_port" != "$pg_port" ] || app_port="$(free_port $((app_port + 1)))"
		password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
		cat >"$STATE_FILE" <<EOF
PG_PORT=$pg_port
APP_PORT=$app_port
PG_PASSWORD=$password
EOF
		umask 022
	fi
	load_state
	export DATABASE_URL="postgres://dokploy:$PG_PASSWORD@127.0.0.1:$PG_PORT/dokploy"

	if ! container_exists; then
		log "starting Postgres ($PG_IMAGE) as $CONTAINER on 127.0.0.1:$PG_PORT"
		# The data lives in tmpfs, so `down` leaves nothing behind. The password
		# is passed by name so it never appears in the process list.
		POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$CONTAINER" --label "$LABEL" \
			--tmpfs /var/lib/postgresql/data \
			-e POSTGRES_USER=dokploy -e POSTGRES_DB=dokploy -e POSTGRES_PASSWORD \
			-p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null
	elif ! container_running; then
		log "restarting Postgres container $CONTAINER"
		docker start "$CONTAINER" >/dev/null
	fi

	log "waiting for Postgres"
	local i
	for i in $(seq 1 60); do
		# -h makes this a TCP check; the temporary server used during init has no TCP listener.
		docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U dokploy -q && break
		[ "$i" -lt 60 ] || die "Postgres did not become ready"
		sleep 1
	done

	cd "$ROOT"
	if [ ! -d node_modules ]; then
		log "installing dependencies (pnpm install --frozen-lockfile)"
		pnpm install --frozen-lockfile
	fi
	# `pnpm server:build` points @dokploy/server at dist; the dev server needs src.
	pnpm server:script >/dev/null

	log "running migrations"
	if ! pnpm --filter=dokploy run migration:run >"$STATE_DIR/migration.log" 2>&1; then
		tail -n 30 "$STATE_DIR/migration.log" >&2
		die "migration command failed"
	fi
	# migration.ts logs a failed batch but still exits 0 so production boots.
	if grep -q "DATABASE MIGRATION FAILED" "$STATE_DIR/migration.log"; then
		tail -n 30 "$STATE_DIR/migration.log" >&2
		die "migrations failed (instance left running; fix, then run down and up)"
	fi

	if server_running; then
		log "dev server already running (pid $(cat "$PID_FILE"))"
	else
		log "starting dev server on $(url) (log: ${LOG_FILE#"$ROOT"/})"
		: >"$LOG_FILE"
		local launcher=(nohup)
		command -v setsid >/dev/null && launcher=(setsid nohup)
		NODE_ENV=development PORT="$APP_PORT" HOST=127.0.0.1 \
			"${launcher[@]}" pnpm --filter=dokploy run dev >>"$LOG_FILE" 2>&1 &
		echo $! >"$PID_FILE"
	fi

	# The first request compiles the page, which can take a couple of minutes.
	log "waiting for $(url) to answer 200"
	for i in $(seq 1 180); do
		http_ok && break
		server_running || { tail -n 30 "$LOG_FILE" >&2; die "dev server exited, see $LOG_FILE"; }
		[ "$i" -lt 180 ] || { tail -n 30 "$LOG_FILE" >&2; die "dev server did not answer 200 in time"; }
		sleep 2
	done

	log "ready: $(url)"
	log "fresh database: open $(url)/register to create the first (admin) account"
	log "tear down with: scripts/dev-instance.sh down"
}

cmd_down() {
	if [ -f "$PID_FILE" ]; then
		local pid
		pid="$(cat "$PID_FILE")"
		if kill -0 "$pid" 2>/dev/null; then
			log "stopping dev server (pid $pid)"
			kill_tree "$pid"
			for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
		fi
	fi
	if [ -f "$STATE_FILE" ]; then
		load_state
		# Anything still listening on the app port is the dev server's orphaned child.
		if command -v fuser >/dev/null && port_in_use "$APP_PORT"; then fuser -k -n tcp "$APP_PORT" >/dev/null 2>&1 || true; fi
	fi
	if container_exists; then
		log "removing $CONTAINER"
		docker rm -f -v "$CONTAINER" >/dev/null
	fi
	rm -rf "$STATE_DIR"
	rmdir "$ROOT/.dev-instance" 2>/dev/null || true
	log "instance $NAME removed"
}

cmd_status() {
	if [ ! -f "$STATE_FILE" ]; then
		log "instance $NAME: not created"
		return 0
	fi
	load_state
	log "instance $NAME"
	container_running && log "postgres: running ($CONTAINER, 127.0.0.1:$PG_PORT)" || log "postgres: not running"
	if server_running; then
		log "dev server: running (pid $(cat "$PID_FILE")), $(url) -> $(http_ok && echo 200 || echo 'not answering 200')"
	else
		log "dev server: not running"
	fi
}

cmd_url() {
	[ -f "$STATE_FILE" ] || die "instance $NAME is not created; run 'up'"
	load_state
	url
}

cmd_logs() {
	[ -f "$LOG_FILE" ] || die "no log for instance $NAME"
	tail -n "${LINES_TO_SHOW:-100}" -f "$LOG_FILE"
}

case "${1:-}" in
	up) cmd_up ;;
	down) cmd_down ;;
	status) cmd_status ;;
	url) cmd_url ;;
	logs) cmd_logs ;;
	*) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
