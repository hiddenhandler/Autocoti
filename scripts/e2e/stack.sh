#!/usr/bin/env bash
# Local Supabase-compatible stack for end-to-end tests:
#   Postgres 16 (host) + GoTrue (auth) + PostgREST (REST) + a tiny gateway on :54321.
# Usage: scripts/e2e/stack.sh up | down
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${E2E_DB:-autocoti_e2e}
SECRET=${E2E_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters}
GOTRUE_IMAGE=${GOTRUE_IMAGE:-supabase/gotrue:v2.170.0}
POSTGREST_IMAGE=${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}

down() {
  docker rm -f autocoti-gotrue autocoti-postgrest >/dev/null 2>&1 || true
  [ -f /tmp/autocoti-gateway.pid ] && kill "$(cat /tmp/autocoti-gateway.pid)" 2>/dev/null || true
  rm -f /tmp/autocoti-gateway.pid
}

up() {
  down
  psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
  sed "s/current_database_placeholder/$DB/" scripts/e2e/roles.sql | psql -v ON_ERROR_STOP=1 -q -d "$DB"

  # GoTrue creates and migrates the auth schema itself.
  docker run -d --name autocoti-gotrue --network host \
    -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9999 -e API_EXTERNAL_URL=http://localhost:54321/auth/v1 \
    -e GOTRUE_DB_DRIVER=postgres \
    -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:e2e-auth-admin@127.0.0.1:5432/$DB?search_path=auth&sslmode=disable" \
    -e GOTRUE_SITE_URL=http://localhost:5173 -e GOTRUE_URI_ALLOW_LIST='*' \
    -e GOTRUE_JWT_SECRET="$SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
    -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_ADMIN_ROLES=service_role \
    -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
    -e GOTRUE_EXTERNAL_PHONE_ENABLED=false -e GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 \
    "$GOTRUE_IMAGE" >/dev/null
  for i in $(seq 1 60); do
    curl -sf http://127.0.0.1:9999/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf http://127.0.0.1:9999/health >/dev/null || { docker logs autocoti-gotrue | tail -30; exit 1; }

  for f in supabase/migrations/*.sql; do
    psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null || { echo "migration failed: $f"; exit 1; }
  done

  docker run -d --name autocoti-postgrest --network host \
    -e "PGRST_DB_URI=postgres://authenticator:e2e-authenticator@127.0.0.1:5432/$DB" \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" \
    -e PGRST_SERVER_PORT=3000 -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_DB_EXTRA_SEARCH_PATH=public,extensions \
    "$POSTGREST_IMAGE" >/dev/null
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1 && break
    sleep 1
  done

  E2E_JWT_SECRET="$SECRET" nohup node scripts/e2e/gateway.mjs >/tmp/autocoti-gateway.log 2>&1 &
  echo $! >/tmp/autocoti-gateway.pid
  sleep 1
  node scripts/e2e/keys.mjs "$SECRET" > .env.e2e
  echo "stack up: gateway http://localhost:54321 (keys in .env.e2e)"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
esac
