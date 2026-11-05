#!/bin/sh
# Full logical backup of InsightAI's PostgreSQL (docs/OPERATIONS.md):
#   1. global roles (tenant reader/writer roles live at cluster level, outside any database dump),
#      without passwords – login passwords are re-applied from the env file on restore;
#   2. the database in custom format (metadata schema `app` + every tenant schema `t_*`).
# The archive is encrypted (AES-256, PBKDF2) and optionally copied to object storage.
#
# Env: DATABASE_ADMIN_URL (superuser or a role able to read pg_roles and every schema),
#      BACKUP_ENCRYPTION_PASSPHRASE, optional BACKUP_S3_BUCKET (+ AWS_* / S3_* credentials),
#      BACKUP_RETENTION_DAYS (default 7, local copies only).
set -eu

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[backup] roles"
# --no-role-passwords reads pg_roles, so it also works on managed services without pg_authid.
pg_dumpall --dbname="$DATABASE_ADMIN_URL" --roles-only --no-role-passwords > "$WORK/roles.sql"

echo "[backup] database"
pg_dump --dbname="$DATABASE_ADMIN_URL" --format=custom --compress=6 --file="$WORK/database.dump"

{
  echo "created_at=$STAMP"
  echo "server_version=$(psql "$DATABASE_ADMIN_URL" -Atc 'SHOW server_version')"
  echo "migrations=$(psql "$DATABASE_ADMIN_URL" -Atc "SELECT count(*) FROM app._prisma_migrations WHERE finished_at IS NOT NULL")"
  echo "last_migration=$(psql "$DATABASE_ADMIN_URL" -Atc "SELECT migration_name FROM app._prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 1")"
  echo "tenant_schemas=$(psql "$DATABASE_ADMIN_URL" -Atc "SELECT count(*) FROM pg_namespace WHERE nspname ~ '^t_[a-z0-9]+$'")"
} > "$WORK/manifest.txt"

ARCHIVE="$DIR/insightai-$STAMP.tar.gz.enc"
tar -C "$WORK" -czf - roles.sql database.dump manifest.txt \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
      -out "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "[backup] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup] uploading to s3://$BACKUP_S3_BUCKET/"
  aws ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} s3 cp "$ARCHIVE" "s3://$BACKUP_S3_BUCKET/"
  aws ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} s3 cp "$ARCHIVE.sha256" "s3://$BACKUP_S3_BUCKET/"
fi

find "$DIR" -name 'insightai-*.tar.gz.enc*' -mtime +"${BACKUP_RETENTION_DAYS:-7}" -delete
echo "[backup] done"
