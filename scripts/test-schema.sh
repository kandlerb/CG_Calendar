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

psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f "${here}/supabase/tests/harness.sql"
psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f "${here}/supabase/schema.sql"

# Captured so we can insist the assertions actually ran. ON_ERROR_STOP already
# fails the run on a broken assertion, but an empty or skipped test file would
# otherwise exit 0 and look like a pass.
output="$(psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f "${here}/supabase/tests/schema_test.sql")"
echo "${output}"

if ! grep -q 'PASSED: [1-9][0-9]* assertions' <<<"${output}"; then
  echo "ERROR: the schema tests did not report any passing assertions." >&2
  exit 1
fi
