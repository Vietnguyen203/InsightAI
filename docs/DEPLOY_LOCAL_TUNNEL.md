# InsightAI – Chạy trên máy Windows của bạn + Cloudflare Tunnel (pilot gate E4, D-61)

Toàn bộ `docker/compose.prod.yml` chạy trong Docker Desktop trên máy này (PostgreSQL, Redis, SeaweedFS, API, worker,
Caddy). Cloudflare Tunnel (`cloudflared`) đưa trang web ra Internet qua HTTPS **mà không mở cổng router, không cần IP
tĩnh**. Dữ liệu nằm trên ổ đĩa máy này, tại Việt Nam. Chi phí: 0 đ (tên miền riêng tùy chọn, §3).

**Giới hạn cần chấp nhận:** máy phải bật, đăng nhập Windows và Docker Desktop đang chạy 24/7; mất điện, mất mạng,
Windows Update khởi động lại ⇒ trang ngừng hoạt động. Phù hợp demo và pilot nhỏ; khi có khách trả phí, chuyển sang
VPS bằng backup → restore (OPERATIONS.md §3–4). Monitor ngoài (§5) báo khi máy tắt.

## 1. Chuẩn bị máy (một lần)

1. Docker Desktop → *Settings → General*: bật **Start Docker Desktop when you sign in to your computer**.
   *Settings → Resources*: Memory ≥ 8 GB.
2. Windows → *Settings → System → Power*: **Sleep = Never** khi cắm sạc (và tắt ngủ đông). Máy tính xách tay: không gập máy
   hoặc chỉnh "Lid close action = Do nothing".
3. Windows Update → *Active hours* đặt theo giờ làm việc để không tự khởi động lại giữa ngày.

## 2. Cài đặt (một lệnh, từ thư mục repo)

```powershell
powershell -ExecutionPolicy Bypass -File docker\local\setup.ps1 -ScheduleBackup
```

Script: sinh `%USERPROFILE%\InsightAI-prod\production.env` (mật khẩu ngẫu nhiên, không in ra, chỉ user Windows của bạn
đọc được), build image, chạy PostgreSQL/Redis/SeaweedFS, tạo bucket, migrate, toàn bộ stack và **Quick Tunnel**; in ra
URL dạng `https://xxxx.trycloudflare.com`. `-ScheduleBackup` tạo tác vụ Task Scheduler "InsightAI backup" lúc 02:00
(chạy khi bạn đang đăng nhập; file trong `%USERPROFILE%\InsightAI-prod\backups`). Chạy lại script bất cứ lúc nào để
cập nhật (`git pull` trước); bí mật được giữ. `-NoTunnel`: chỉ dùng trong máy tại `http://localhost:8088`.

**Sao lưu ngay `production.env`** vào trình quản lý mật khẩu: không có `BACKUP_ENCRYPTION_PASSPHRASE` thì không giải
mã được backup.

Quick Tunnel chỉ để demo: URL **đổi mỗi lần khởi động lại** và Cloudflare **không hỗ trợ SSE** trên Quick Tunnel ⇒ câu
trả lời AI dạng luồng và tiến trình điều tra trực tiếp không hoạt động. Pilot thật dùng Named Tunnel (§3).

## 3. Named Tunnel – URL cố định, có SSE (cho pilot)

Cần một tên miền đặt DNS ở Cloudflare (gói Free). Tên miền: mua (Cloudflare Registrar giá gốc, hoặc nhà đăng ký VN rồi
đổi nameserver sang Cloudflare) hoặc miễn phí qua `eu.org` (duyệt vài ngày).

1. <https://dash.cloudflare.com> → **Add a domain** → gói **Free** → đổi nameserver tại nơi mua tên miền theo hướng dẫn,
   chờ trạng thái *Active*.
2. **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared* → đặt tên `insightai` → ở bước cài đặt, chỉ
   **copy token** (chuỗi dài sau `--token`), không cần chạy lệnh cài.
3. **Public Hostname**: Subdomain `app` (ví dụ), Domain của bạn, Service **HTTP** – URL **`web:80`** → Save.
4. Mở `%USERPROFILE%\InsightAI-prod\production.env`, điền `CLOUDFLARE_TUNNEL_TOKEN=<token>` (không dán token vào chat),
   lưu, rồi chạy lại `setup.ps1`. Container `cloudflared` thay cho Quick Tunnel; trang ở `https://app.<tên-miền>`.

## 4. Vận hành

```powershell
docker\local\ops.ps1 ps
```

```powershell
docker\local\ops.ps1 logs -f --tail 100 api worker
```

`ops.ps1` = `docker compose` với đúng env file và profile (mọi tham số chuyển thẳng cho compose). Backup thủ công:
`docker\local\ops.ps1 --profile backup run --rm backup`. Dừng: `docker\local\ops.ps1 down` (dữ liệu vẫn trong volume).
AI: thêm `OPENAI_API_KEY`, `OPENAI_MODEL` (+ `OPENAI_BASE_URL`) vào env file rồi `docker\local\ops.ps1 up -d api worker`.

## 5. Kiểm tra sau triển khai (đóng gate E4)

| Bước | Cách làm | Đạt khi |
|---|---|---|
| Smoke | `docker run --rm -v ${PWD}\docker:/s:ro node:24.18.0-bookworm-slim node /s/smoke.mjs https://<url>` | mọi bước OK |
| Trình duyệt / điện thoại (4G) | mở `https://<url>`, đăng ký, upload CSV, hỏi đáp (Named Tunnel + AI key) | trang chạy ngoài mạng nhà |
| Cảnh báo | `OPS_ALERT_WEBHOOK_URL` (Slack/Discord) trong env file, `ops.ps1 up -d worker`, rồi `docker\local\ops.ps1 run --rm worker node dist/ops-alert-test.js` | tin "Test alert" trong kênh |
| Uptime ngoài | UptimeRobot `https://<url>/health/ready` mỗi 5 phút; healthchecks.io cho `OPS_HEARTBEAT_URL` | nhận email khi tắt Docker Desktop thử |
| Restore | OPERATIONS.md §4 với backup đêm đầu | dữ liệu khớp |

## 6. Bảo mật

- Không mở cổng nào trên router; chỉ `cloudflared` kết nối ra ngoài. Cổng 8088/8448 trên máy chỉ để kiểm tra tại chỗ –
  không chuyển tiếp chúng trên router.
- Caddy giữ IP thật của người dùng qua tunnel (`CADDY_TRUSTED_PROXIES=private_ranges`, `TRUST_PROXY_HOPS=2`) cho rate
  limit và audit log. Không đặt hai giá trị này khi không chạy sau tunnel.
- Bật BitLocker cho ổ đĩa (dữ liệu khách hàng nằm trên máy này); giữ Windows cập nhật.
