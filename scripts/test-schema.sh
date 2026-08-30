#!/usr/bin/env bash
# Applies supabase/schema.sql to a scratch database and runs its tests.
#
#   ./scripts/test-schema.sh
#
# Needs a PostgreSQL you can connect to. Set PGHOST / PGUSER / PGPASSWORD as
# usual; by default it uses your local socket. The scratch database is dropped
# and recreated on every run.
set -euo pipefail

DB="${CG_TEST_DB:-cg_calendar_schema_test}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists ${DB}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database ${DB}"

for file in supabase/tests/harness.sql supabase/schema.sql supabase/tests/schema_test.sql; do
  psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f "${here}/${file}"
done
