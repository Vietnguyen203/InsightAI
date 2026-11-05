# Backup/restore toolbox: PostgreSQL 16 client tools (same major as the server), OpenSSL for
# encryption and the AWS CLI for any S3-compatible object storage.
FROM postgres:16.15-alpine
RUN apk add --no-cache openssl aws-cli
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
USER postgres
WORKDIR /backups
ENTRYPOINT []
CMD ["backup.sh"]
