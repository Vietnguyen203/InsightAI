# InsightAI – Deployment (MVP)

Mục tiêu: một máy chủ chạy Docker Compose; PostgreSQL tự quản (profile `selfhosted-db`) hoặc managed. Lựa chọn hạ tầng: [PHASE6_AUDIT.md](PHASE6_AUDIT.md) §7. Pilot miễn phí trên một VM Oracle Cloud (script cài đặt một lệnh, profile `selfhosted-s3`): [DEPLOY_ORACLE.md](DEPLOY_ORACLE.md) (D-60). Trên máy Windows của bạn + Cloudflare Tunnel (đang chọn cho pilot): [DEPLOY_LOCAL_TUNNEL.md](DEPLOY_LOCAL_TUNNEL.md) (D-61).

## 1. Thành phần

| Service | Image | Vai trò |
|---|---|---|
| `web` | `apps/web/Dockerfile` (Caddy + SPA) | Cổng duy nhất mở ra ngoài (80/443), HTTPS tự động, reverse proxy `/api`, `/health` → `api` (SSE không buffer, `read_timeout 0`), header bảo mật |
| `api` | `apps/api/Dockerfile` (`runtime`) | `node dist/main.js`, non-root, healthcheck `/health/live` |
| `worker` | cùng image | `node dist/worker.js` (import, profiling, quality, cleaning) |
| `migrate` | `apps/api/Dockerfile` (`migrate`) | Chạy một lần trước api/worker: tạo/cập nhật role PostgreSQL (`scripts/bootstrap-db.mjs`) rồi `prisma migrate deploy` |
| `redis` | `redis:7.4.12-alpine` | `--requirepass` bắt buộc; API từ chối khởi động ở production nếu `REDIS_URL` thiếu mật khẩu |
| `postgres` | `postgres:16.15-alpine` | Chỉ với profile `selfhosted-db` |
| `seaweedfs` | `chrislusf/seaweedfs:4.48` | Chỉ với profile `selfhosted-s3` (object storage trên cùng máy, mạng nội bộ) |
| `cloudflared` / `cloudflared-quick` | `cloudflare/cloudflared:2025.10.1` | Profile `tunnel` (token) / `quick-tunnel`: đưa `web:80` ra Internet qua Cloudflare, không mở cổng |
| `backup` | `docker/backup/Dockerfile` | Profile `backup`: `backup.sh` / `restore.sh` ([OPERATIONS.md](OPERATIONS.md)) |

PostgreSQL và Redis chỉ nằm trong mạng nội bộ `internal`, không publish cổng.

## 2. Chuẩn bị

1. Máy chủ Linux có Docker Engine + Compose v2.20+; DNS của tên miền trỏ về máy chủ (cổng 80/443 mở).
2. Object storage S3-compatible và bucket đã tạo (ứng dụng không tạo bucket ở production).
3. Tạo file env **ngoài repository**, quyền 600:
   ```bash
   sudo install -m 600 docker/production.env.example /etc/insightai/production.env
   ```
   Điền mọi giá trị `<...>`; sinh bí mật bằng `openssl rand -base64 32`. Không commit file này.
4. PostgreSQL managed: bỏ profile `selfhosted-db`, trỏ các `DATABASE_*_URL` tới máy chủ managed. `DATABASE_ADMIN_URL` cần quyền `CREATEROLE` và tạo schema (tenant provisioning tạo role theo từng tổ chức) – **xác minh với nhà cung cấp trước khi chọn**.

## 3. Build và chạy

```bash
docker build -f apps/api/Dockerfile -t insightai-api:latest .
docker build -f apps/api/Dockerfile --target migrate -t insightai-migrate:latest .
docker build -f apps/web/Dockerfile -t insightai-web:latest .
export INSIGHTAI_ENV_FILE=/etc/insightai/production.env   # đường dẫn tuyệt đối
docker compose -f docker/compose.prod.yml --env-file "$INSIGHTAI_ENV_FILE" --profile selfhosted-db up -d
node docker/smoke.mjs https://analytics.example.vn
```

Thứ tự khởi động: `postgres`/`redis` healthy → `migrate` hoàn tất → `api` healthy → `worker`, `web`. Cập nhật phiên bản: build image mới rồi `up -d` lại (migrate chạy lại, idempotent). Rollback: dùng image trước đó; migration mới là bổ sung, không tự đảo ngược – rollback schema chỉ qua restore.

## 4. Kiểm tra sau triển khai

`docker/smoke.mjs` (qua cổng công khai): `/health/live|ready`, SPA + header bảo mật, đăng ký (tạo tổ chức + schema tenant), upload CSV và import trong worker, trạng thái AI, mặc định `aiDataSharing = METADATA_ONLY`. Tài khoản smoke có email `@smoke.insightai.local`; xóa định kỳ nếu chạy trên production.

## 5. Ghi chú

- `TRUST_PROXY_HOPS=1` (sau Caddy) để rate limit và audit dùng IP thật.
- SSE: Caddy `flush_interval -1`; API gửi heartbeat `: ping` mỗi `AI_SSE_HEARTBEAT_MS` và dừng câu trả lời sau `AI_ANSWER_TIMEOUT_MS` (`AI_TIMEOUT`). Nếu đặt thêm proxy/load balancer phía trước, tắt buffering và đặt idle timeout > 2 × heartbeat.
- AI: không cấu hình `OPENAI_API_KEY` thì Hỏi đáp báo "chưa cấu hình". Mỗi tổ chức mặc định chỉ gửi metadata (D-50).
- Image API ~0,9 GB (node_modules production gồm Prisma CLI do peer dependency) – tối ưu sau.
