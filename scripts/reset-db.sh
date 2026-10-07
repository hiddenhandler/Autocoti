#!/usr/bin/env bash
# Recreate a local database, apply the Supabase auth shim + all migrations.
set -euo pipefail
DB=${1:-barberngo_test}
cd "$(dirname "$0")/.."
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f scripts/auth-shim.sql
for f in supabase/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" || { echo "FAILED: $f"; exit 1; }
done
echo "ok: $DB"
