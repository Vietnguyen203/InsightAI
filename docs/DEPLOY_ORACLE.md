# InsightAI – Triển khai miễn phí trên Oracle Cloud (pilot gate E4)

Một máy ảo Oracle Cloud **Always Free** (Ampere arm64, tối đa 4 OCPU / 24 GB RAM, 200 GB đĩa) chạy toàn bộ
`docker/compose.prod.yml`: Caddy (HTTPS), API, worker, PostgreSQL, Redis, SeaweedFS (profile `selfhosted-s3`).
Tên miền miễn phí qua DuckDNS. Chi phí: 0 USD (Oracle cần thẻ để xác minh, không trừ tiền với tài nguyên Always Free).

Giới hạn cần chấp nhận cho pilot (D-60): không SLA; Oracle có thể thu hồi VM free gần như không hoạt động 7 ngày;
dữ liệu nằm ở vùng đã chọn (ngoài Việt Nam) – ghi rõ trong thỏa thuận dữ liệu (E8); file upload gốc nằm trên đĩa VM
(backup database hằng ngày, bản sao ngoài máy nên cấu hình – §6). Khi có khách trả phí: chuyển sang VPS/DB managed
bằng backup → restore (OPERATIONS.md §3–4).

## 1. Tài khoản và máy ảo (bạn làm trên web)

1. Đăng ký <https://signup.oraclecloud.com>. **Home region** chọn gần Việt Nam (Singapore `ap-singapore-1` hoặc Tokyo);
   không đổi được sau này. Thẻ chỉ để xác minh.
2. Tạo SSH key trên máy bạn (PowerShell): `ssh-keygen -t ed25519 -f $HOME\.ssh\insightai-oracle`.
3. Console → **Compute → Instances → Create instance**:
   - Image: **Canonical Ubuntu 24.04** (bản thường, không "Minimal").
   - Shape: **Ampere → VM.Standard.A1.Flex**, 4 OCPU, 24 GB RAM (nhãn "Always Free-eligible").
   - Networking: mạng mặc định, **Assign a public IPv4 address**.
   - SSH keys: dán nội dung `insightai-oracle.pub`.
   - Boot volume: 100–200 GB.
   - Báo "Out of capacity": thử lại sau vài giờ, đổi Availability Domain, hoặc giảm còn 2 OCPU / 12 GB.
4. Mở cổng web: Instance → subnet → **Security List** → *Add Ingress Rules*: Source `0.0.0.0/0`, TCP, port `80`;
   thêm rule thứ hai cho `443`. (Tường lửa trong máy do `setup.sh` mở.)
5. (Nên làm) **Networking → Reserved Public IPs**: giữ IP cố định cho instance.

## 2. Tên miền miễn phí (DuckDNS)

1. Đăng nhập <https://www.duckdns.org>, tạo subdomain, ví dụ `insightai-pilot` → `insightai-pilot.duckdns.org`.
2. Ô *current ip*: nhập public IP của VM → **update ip**.
3. Kiểm tra: `nslookup insightai-pilot.duckdns.org` trả đúng IP.

## 3. Cài InsightAI (một lệnh trên VM)

```bash
ssh -i ~/.ssh/insightai-oracle ubuntu@<public-ip>
```

```bash
git clone https://github.com/Vietnguyen203/InsightAI.git && cd InsightAI
```

```bash
sudo bash docker/oracle/setup.sh insightai-pilot.duckdns.org
```

Tham số thứ hai (tùy chọn) là webhook cảnh báo Slack/Discord. Script: cài Docker (repo apt chính thức), mở 80/443
trong iptables, sinh `/etc/insightai/production.env` với mật khẩu ngẫu nhiên (không in ra), build image cho arm64
(~15–25 phút lần đầu), khởi động PostgreSQL/Redis/SeaweedFS, tạo bucket, chạy migrate rồi toàn bộ stack, đặt cron
backup 02:00. Chạy lại an toàn để cập nhật (`git pull` rồi chạy lại lệnh trên; bí mật được giữ).

**Sao lưu ngay `/etc/insightai/production.env`** vào trình quản lý mật khẩu (`sudo cat` rồi copy): không có
`BACKUP_ENCRYPTION_PASSPHRASE` thì không giải mã được backup.

## 4. Vận hành hằng ngày

```bash
sudo bash docker/oracle/ops.sh ps
```

```bash
sudo bash docker/oracle/ops.sh logs -f --tail 100 api worker
```

`ops.sh` là `docker compose` với đúng env file và profile. Backup thủ công:
`sudo bash docker/oracle/ops.sh --profile backup run --rm backup` (file trong `/var/backups/insightai`).

## 5. Kiểm tra sau triển khai (đóng gate E4)

| Bước | Lệnh / nơi làm | Đạt khi |
|---|---|---|
| Smoke | `sudo docker run --rm -v $PWD/docker:/s:ro node:24.18.0-bookworm-slim node /s/smoke.mjs https://<domain>` | mọi bước OK |
| Trình duyệt | `https://<domain>`: đăng ký, upload CSV, hỏi đáp (khi có AI key) | ổ khóa HTTPS hợp lệ |
| Cảnh báo | đặt `OPS_ALERT_WEBHOOK_URL` trong env file, `sudo bash docker/oracle/ops.sh up -d worker`, rồi `sudo bash docker/oracle/ops.sh run --rm worker node dist/ops-alert-test.js` | tin "Test alert" trong kênh |
| Uptime ngoài | UptimeRobot: `https://<domain>/health/live` và `/health/ready` mỗi 5 phút; healthchecks.io cho `OPS_HEARTBEAT_URL` | nhận email khi tắt thử `api` |
| Restore | OPERATIONS.md §4 với backup đêm đầu tiên | dữ liệu khớp, ghi RTO |
| Hiệu năng | `k6/seed.mjs` + `k6 run k6/load.mjs` từ máy bạn với `PERF_API_URL=https://<domain>/api/v1` (tạm `RATE_LIMIT_ENABLED=false`) | ngưỡng PERFORMANCE.md |

## 6. Nên làm thêm

- AI: thêm `OPENAI_API_KEY`, `OPENAI_MODEL` (+ `OPENAI_BASE_URL` nếu không phải OpenAI) vào env file rồi
  `sudo bash docker/oracle/ops.sh up -d api worker`.
- Backup ngoài máy: bucket Cloudflare R2 hoặc Backblaze B2 (free 10 GB), điền `BACKUP_S3_BUCKET`,
  `BACKUP_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` trong env file.
- Cập nhật bảo mật Ubuntu tự động: `sudo apt install unattended-upgrades`.
