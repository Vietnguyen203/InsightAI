#!/bin/sh
# Restores a backup made by backup.sh into an EMPTY PostgreSQL 16 server (docs/OPERATIONS.md).
#   restore.sh /backups/insightai-<stamp>.tar.gz.enc
# Order matters: roles first (tenant roles own nothing but hold grants), then the database with
# its original owners and grants. Afterwards run the `migrate` job: it re-applies the login
# passwords from the env file (roles are dumped without passwords) and confirms migrations.
#
# Env: RESTORE_ADMIN_URL – superuser URL of the target server, pointing at the maintenance
#      database (e.g. postgresql://postgres:…@host:5432/postgres); RESTORE_DATABASE (default
#      insightai); BACKUP_ENCRYPTION_PASSPHRASE.
set -eu

ARCHIVE="${1:?usage: restore.sh <archive.tar.gz.enc>}"
: "${RESTORE_ADMIN_URL:?RESTORE_ADMIN_URL is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
DB="${RESTORE_DATABASE:-insightai}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -f "$ARCHIVE.sha256" ]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  -in "$ARCHIVE" | tar -C "$WORK" -xzf -
echo "[restore] manifest:"; sed 's/^/  /' "$WORK/manifest.txt"

EXISTING="$(psql "$RESTORE_ADMIN_URL" -Atc "SELECT count(*) FROM pg_database WHERE datname = '$DB'")"
if [ "$EXISTING" != "0" ]; then
  echo "[restore] database \"$DB\" already exists: refusing to overwrite" >&2
  exit 1
fi

echo "[restore] roles"
# The superuser running the restore already exists; skip its CREATE/ALTER lines.
ADMIN_ROLE="$(psql "$RESTORE_ADMIN_URL" -Atc 'SELECT current_user')"
grep -v -E "^(CREATE|ALTER) ROLE \"?$ADMIN_ROLE\"?( |;)" "$WORK/roles.sql" > "$WORK/roles.filtered.sql"
psql "$RESTORE_ADMIN_URL" --set ON_ERROR_STOP=1 --quiet --file "$WORK/roles.filtered.sql"

echo "[restore] database"
psql "$RESTORE_ADMIN_URL" --set ON_ERROR_STOP=1 --quiet -c "CREATE DATABASE \"$DB\""
TARGET_URL="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/$DB\1#")"
pg_restore --dbname="$TARGET_URL" --exit-on-error --jobs=4 "$WORK/database.dump"

echo "[restore] checks"
psql "$TARGET_URL" -Atc "SELECT 'migrations=' || count(*) FROM app._prisma_migrations WHERE finished_at IS NOT NULL"
psql "$TARGET_URL" -Atc "SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname ~ '^t_[a-z0-9]+$'"
psql "$TARGET_URL" -Atc "SELECT 'organizations=' || count(*) FROM app.organizations"
echo "[restore] done – now run the migrate job to set login passwords, then start api/worker"
