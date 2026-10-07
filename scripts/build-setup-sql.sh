#!/usr/bin/env bash
# Concatenate all migrations into supabase/setup.sql (one paste into the Supabase SQL Editor).
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "-- BarberNGo: complete database setup for a Supabase project."
  echo "-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run (run once, on a fresh project)."
  echo "-- Generated from supabase/migrations/*.sql by scripts/build-setup-sql.sh — do not edit by hand."
  echo
  for f in supabase/migrations/*.sql; do
    echo "-- ===================== $(basename "$f") ====================="
    cat "$f"
    echo
  done
} > supabase/setup.sql
echo "wrote supabase/setup.sql"
