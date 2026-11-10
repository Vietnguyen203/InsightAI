# InsightAI – Operations: backup, restore & monitoring

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

## 6. Giám sát & cảnh báo (D-58)

Hai lớp, vì hệ thống không tự báo được khi cả máy chủ chết:

1. **Bên ngoài (bắt buộc)** – dịch vụ uptime (UptimeRobot, Better Stack, healthchecks.io…) kiểm tra mỗi 1 phút
   `https://<domain>/health/live` (tiến trình sống) và `https://<domain>/health/ready` (PostgreSQL, Redis, S3; 503 kèm
   thành phần lỗi), và nhận heartbeat `OPS_HEARTBEAT_URL` (báo động khi monitor ngừng ping ⇒ worker/Redis chết).
2. **Monitor trong worker** – mỗi `OPS_MONITOR_INTERVAL_SECONDS` (60 s), một worker (khóa Redis) đo 5 chỉ số, ghi log
   JSON `ops snapshot`, gửi cảnh báo và lưu snapshot cho `GET /health/ops`.

| Chỉ số | Nguồn | Cảnh báo (mặc định) |
|---|---|---|
| API sẵn sàng | `OPS_API_URL/health/ready` (compose: `http://api:3100`) | `api_not_ready` khi khác 200 |
| Lỗi 5xx | bộ đếm Redis theo phút, mọi instance API (ProblemDetailsFilter) | `server_errors` ≥ `OPS_ALERT_5XX_PER_5MIN` (10) trong 5 phút |
| Hàng đợi tồn | BullMQ: waiting/active/delayed/failed, tuổi job chờ lâu nhất | `queue_backlog:<queue>` khi waiting ≥ 100 hoặc job cũ nhất ≥ 600 s |
| Dung lượng đĩa | `statfs` của `OPS_DISK_PATHS` (mặc định `WORK_DIR`/thư mục tạm của container = đĩa Docker) | `disk:<path>` ≥ 85 % |
| Chi phí LLM/ngày | token theo model, ngày UTC (bộ đếm Redis, ghi cùng `llm_usage`) × giá `OPS_LLM_PRICE_*_PER_MTOK` | `llm_cost` ≥ `OPS_LLM_DAILY_BUDGET_USD` |

- Monitor chỉ đọc tổng số (không dữ liệu tổ chức/người dùng), không cần quyền đọc chéo metadata (RLS giữ nguyên).
- Cảnh báo: `FIRING` khi bắt đầu, nhắc lại mỗi `OPS_ALERT_REPEAT_MINUTES` (240) nếu còn, `RESOLVED` một lần khi hết.
  Luôn ghi log (level error/warn); gửi `OPS_ALERT_WEBHOOK_URL` (JSON `{ text, alert }`, dùng được với Slack incoming
  webhook) nếu cấu hình. Webhook lỗi không dừng monitor (log `Alert webhook failed`).
- **Bảng vận hành**: `curl -H "Authorization: Bearer $OPS_STATUS_TOKEN" https://<domain>/health/ops` trả snapshot mới
  nhất (5 chỉ số + cảnh báo đang bật); 404 khi chưa đặt token, 401 sai token, 503 khi không có snapshot (monitor không
  chạy). Lịch sử: lọc log JSON theo `msg = "ops snapshot"` (hoặc đẩy log vào Loki/Better Stack – tùy chọn).
- **Thử cảnh báo** (sau khi cấu hình và trong mỗi lần diễn tập):

```bash
docker compose -f docker/compose.prod.yml --env-file /etc/insightai/production.env run --rm worker node dist/ops-alert-test.js
```

  Kết quả mong đợi: `Test alert sent` và một tin `FIRING: Test alert` trong kênh. Thử thêm cảnh báo thật: đặt tạm
  `OPS_ALERT_DISK_PERCENT=1`, `up -d worker`, chờ 1 phút ⇒ `disk:` FIRING; trả lại giá trị cũ ⇒ RESOLVED.
- Xử lý nhanh: `api_not_ready` → `docker compose ps`, log `api`, `/health/ready` cho biết thành phần lỗi;
  `server_errors` → log `Unhandled error` theo `requestId`; `queue_backlog` → log `worker`, worker còn chạy không;
  `disk` → `docker system df`, thư mục backup, dung lượng PostgreSQL; `llm_cost` → hạ `AI_DAILY_QUESTION_LIMIT`.
