#!/usr/bin/env bash
# Concatenate all migrations into supabase/setup.sql (one paste into the Supabase SQL Editor).
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "-- BarberNGo: complete database setup for a Supabase project."
  echo "-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run (run once, on a fresh project)."
  echo "-- Generated from supabase/migrations/*.sql by scripts/build-setup-sql.sh — do not edit by hand."
  echo "-- Runs as one transaction: if anything fails, nothing is created. If a previous attempt left"
  echo "-- objects behind (\"already exists\" errors), run supabase/reset.sql first."
  echo
  echo "begin;"
  echo
  for f in supabase/migrations/*.sql; do
    echo "-- ===================== $(basename "$f") ====================="
    cat "$f"
    echo
  done
  echo "commit;"
} > supabase/setup.sql
echo "wrote supabase/setup.sql"
