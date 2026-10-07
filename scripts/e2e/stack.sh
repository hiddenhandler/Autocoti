#!/usr/bin/env bash
# Local Supabase-compatible stack for end-to-end tests:
#   Postgres 16 (host) + GoTrue (auth) + PostgREST (REST) + a tiny gateway on :54321.
# Usage: scripts/e2e/stack.sh up | down
# Without Docker, point GOTRUE_BIN / POSTGREST_BIN at the official release binaries
# (github.com/supabase/auth, github.com/PostgREST/postgrest) and they run natively.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${E2E_DB:-barberngo_e2e}
SECRET=${E2E_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters}
GOTRUE_IMAGE=${GOTRUE_IMAGE:-supabase/gotrue:v2.170.0}
POSTGREST_IMAGE=${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}

NATIVE=$([ -n "${GOTRUE_BIN:-}" ] && [ -n "${POSTGREST_BIN:-}" ] && echo 1 || echo 0)

down() {
  if [ "$NATIVE" = 1 ]; then
    for p in gotrue postgrest; do
      [ -f "/tmp/barberngo-$p.pid" ] && kill "$(cat "/tmp/barberngo-$p.pid")" 2>/dev/null || true
      rm -f "/tmp/barberngo-$p.pid"
    done
  else
    docker rm -f barberngo-gotrue barberngo-postgrest >/dev/null 2>&1 || true
  fi
  [ -f /tmp/barberngo-gateway.pid ] && kill "$(cat /tmp/barberngo-gateway.pid)" 2>/dev/null || true
  rm -f /tmp/barberngo-gateway.pid
}

up() {
  down
  psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
  sed "s/current_database_placeholder/$DB/" scripts/e2e/roles.sql | psql -v ON_ERROR_STOP=1 -q -d "$DB"

  # GoTrue creates and migrates the auth schema itself.
  GOTRUE_ENV=(
    GOTRUE_API_HOST=127.0.0.1 PORT=9999 API_EXTERNAL_URL=http://localhost:54321/auth/v1
    GOTRUE_DB_DRIVER=postgres
    "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:e2e-auth-admin@127.0.0.1:5432/$DB?search_path=auth&sslmode=disable"
    GOTRUE_SITE_URL=http://localhost:5173 'GOTRUE_URI_ALLOW_LIST=*'
    GOTRUE_JWT_SECRET="$SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated
    GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
    GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true
    GOTRUE_EXTERNAL_PHONE_ENABLED=false GOTRUE_RATE_LIMIT_EMAIL_SENT=1000
  )
  if [ "$NATIVE" = 1 ]; then
    env "${GOTRUE_ENV[@]}" GOTRUE_DB_MIGRATIONS_PATH="$(dirname "$GOTRUE_BIN")/migrations" \
      nohup "$GOTRUE_BIN" >/tmp/barberngo-gotrue.log 2>&1 &
    echo $! >/tmp/barberngo-gotrue.pid
  else
    args=(); for e in "${GOTRUE_ENV[@]}"; do args+=(-e "$e"); done
    docker run -d --name barberngo-gotrue --network host "${args[@]}" "$GOTRUE_IMAGE" >/dev/null
  fi
  for i in $(seq 1 60); do
    curl -sf http://127.0.0.1:9999/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf http://127.0.0.1:9999/health >/dev/null || { { [ "$NATIVE" = 1 ] && tail -30 /tmp/barberngo-gotrue.log || docker logs barberngo-gotrue | tail -30; }; exit 1; }

  for f in supabase/migrations/*.sql; do
    psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null || { echo "migration failed: $f"; exit 1; }
  done

  PGRST_ENV=(
    "PGRST_DB_URI=postgres://authenticator:e2e-authenticator@127.0.0.1:5432/$DB"
    PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$SECRET"
    PGRST_SERVER_PORT=3000 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_EXTRA_SEARCH_PATH=public,extensions
  )
  if [ "$NATIVE" = 1 ]; then
    env "${PGRST_ENV[@]}" nohup "$POSTGREST_BIN" >/tmp/barberngo-postgrest.log 2>&1 &
    echo $! >/tmp/barberngo-postgrest.pid
  else
    args=(); for e in "${PGRST_ENV[@]}"; do args+=(-e "$e"); done
    docker run -d --name barberngo-postgrest --network host "${args[@]}" "$POSTGREST_IMAGE" >/dev/null
  fi
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1 && break
    sleep 1
  done

  E2E_JWT_SECRET="$SECRET" nohup node scripts/e2e/gateway.mjs >/tmp/barberngo-gateway.log 2>&1 &
  echo $! >/tmp/barberngo-gateway.pid
  sleep 1
  node scripts/e2e/keys.mjs "$SECRET" > .env.e2e
  echo "stack up: gateway http://localhost:54321 (keys in .env.e2e)"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
esac
