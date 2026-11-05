# InsightAI – Operations: backup & restore

## 1. Vì sao cần cả "global roles"

Mỗi tổ chức có schema `t_*` và hai role cấp cluster `t_*_reader`, `t_*_writer` (D-04, D-06). `pg_dump` một database **không** chứa role; restore chỉ bằng `pg_dump` sẽ thiếu role và grant ⇒ data plane không truy vấn được (R-01). Vì vậy bản backup gồm:

| Phần | Lệnh | Ghi chú |
|---|---|---|
| `roles.sql` | `pg_dumpall --roles-only --no-role-passwords` | Không chứa mật khẩu; mật khẩu login được đặt lại từ env file bởi job `migrate` |
| `database.dump` | `pg_dump --format=custom` | Schema `app` + mọi schema `t_*`, owner và grant |
| `manifest.txt` | | thời điểm, phiên bản server, số migration, số schema tenant |

Archive được mã hóa `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` bằng `BACKUP_ENCRYPTION_PASSPHRASE` (lưu tách khỏi nơi chứa backup), kèm file `.sha256`. Database-level grants (`CONNECT`) không nằm trong `pg_dump`; job `migrate` cấp lại.

## 2. Backup

```bash
export INSIGHTAI_ENV_FILE=/etc/insightai/production.env
docker compose -f docker/compose.prod.yml --env-file "$INSIGHTAI_ENV_FILE" --profile backup run --rm backup
```

- Ghi vào `BACKUP_HOST_DIR` (mặc định `docker/backups`), xóa bản cục bộ cũ hơn `BACKUP_RETENTION_DAYS` (7).
- `BACKUP_S3_BUCKET` (+ `BACKUP_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`): sao chép lên object storage **khác vùng/nhà cung cấp**; đặt lifecycle 30 ngày + 12 bản tháng tại bucket.
- Lịch đề xuất (cron máy chủ): hằng ngày 02:00. RPO tự quản ≈ 24 h; dùng PostgreSQL managed có PITR để RPO ≤ 5 phút (backup logic vẫn giữ vì chứa roles và dùng được giữa các nhà cung cấp).
- File upload gốc trong object storage: bật versioning/replication của bucket (không nằm trong backup DB).

## 3. Restore (vào PostgreSQL 16 trống)

```bash
# 1. Máy chủ PostgreSQL trống (cùng major 16). Không restore đè database đang chạy.
# 2. Khôi phục roles + database
docker compose -f docker/compose.prod.yml --env-file "$INSIGHTAI_ENV_FILE" --profile backup run --rm \
  -e RESTORE_ADMIN_URL=postgresql://postgres:<pw>@<host>:5432/postgres \
  backup restore.sh /backups/insightai-<stamp>.tar.gz.enc
# 3. Đặt lại mật khẩu login + kiểm tra migration
docker compose -f docker/compose.prod.yml --env-file "$INSIGHTAI_ENV_FILE" run --rm migrate
# 4. Khởi động api/worker/web rồi chạy smoke
node docker/smoke.mjs https://analytics.example.vn
```

`restore.sh` kiểm tra sha256, từ chối nếu database đích đã tồn tại, khôi phục roles (bỏ dòng của superuser đang chạy), tạo database, `pg_restore --exit-on-error`, rồi in số migration/schema tenant/tổ chức để so với manifest.

## 4. Diễn tập restore (bắt buộc trước go-live, sau đó mỗi quý)

Kết quả diễn tập ngày 2026-11-05 (máy local, compose production, dữ liệu smoke):

| Bước | Kết quả |
|---|---|
| `backup.sh` trên database production-compose | archive 32 KB, mã hóa, sha256 |
| `restore.sh` vào `postgres:16.15-alpine` trống | 13 migration, 2 schema tenant, 2 tổ chức – khớp manifest |
| Job `migrate` trên bản khôi phục | đặt lại mật khẩu role, "No pending migrations" |
| API mới trỏ vào bản khôi phục | đăng nhập tài khoản cũ, đọc dòng dataset từ schema tenant (qua `SET ROLE t_*_reader`) |

Ghi lại mỗi lần diễn tập: ngày, kích thước, thời gian restore (RTO), người thực hiện, sai lệch.

## 5. Bí mật

- Chỉ trong `/etc/insightai/production.env` (600) hoặc secret manager; không trong image (CI kiểm tra), không trong repository, không trong log (`parseEnv` chỉ báo tên biến).
- Xoay vòng: đổi giá trị trong env file rồi chạy lại `migrate` (đặt lại mật khẩu role) và `up -d`. `JWT_ACCESS_SECRET` đổi ⇒ mọi access token hết hiệu lực (refresh token vẫn dùng được).
