#!/usr/bin/env bash
# `docker compose` for the single-VM deployment made by setup.sh, with its env file and profiles:
#   sudo bash docker/oracle/ops.sh ps
#   sudo bash docker/oracle/ops.sh logs -f api
#   sudo bash docker/oracle/ops.sh --profile backup run --rm backup
set -euo pipefail
ETC=/etc/insightai
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export INSIGHTAI_ENV_FILE="$ETC/production.env"
export SEAWEEDFS_S3_CONFIG="$ETC/seaweedfs-s3.json"
export BACKUP_HOST_DIR=/var/backups/insightai
exec docker compose -f "$REPO/docker/compose.prod.yml" --env-file "$INSIGHTAI_ENV_FILE" \
  --profile selfhosted-db --profile selfhosted-s3 "$@"
