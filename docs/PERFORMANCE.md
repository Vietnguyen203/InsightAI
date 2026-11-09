# InsightAI – Performance (k6, Phase 6H-2)

Ngưỡng chấp nhận (PHASE6_AUDIT §6): dataset 2 triệu dòng, 20 VU; p95 truy vấn cache-miss ≤ 3 s, cache-hit ≤ 300 ms,
dashboard 10 widget ≤ 5 s, lỗi < 1 %. Kịch bản và ngưỡng nằm trong `k6/load.mjs` (k6 tự báo FAIL khi vượt ngưỡng).

## Cách chạy (thủ công, không chạy trong CI – D-57)

```bash
pnpm infra:up && pnpm db:migrate && pnpm --filter @insightai/api build
```

```bash
PORT=3300 QUEUE_PREFIX=insightai-perf RATE_LIMIT_ENABLED=false LOG_LEVEL=warn node e2e/backend.mjs
```

```bash
node k6/seed.mjs
```

```bash
k6 run k6/load.mjs
```

```bash
COLD=1 k6 run k6/load.mjs
```

- `seed.mjs` chỉ dùng API công khai: đăng ký org mới, import `customers` (5.000 dòng) và `orders` (2.000.000 dòng,
  85 MB, 2025-01-01 → 2026-10-31, seed cố định), model `sales` (order → customer), metric `paid_revenue`,
  `paid_orders`, `aov` (RATIO), dashboard ORG 10 widget (KPI, so sánh kỳ, theo tháng/tuần, theo miền/kênh/thành phố).
  Ghi thông tin đăng nhập vào `k6/.perf-seed.json` (git-ignored). Email thuộc domain test nên `pnpm test:int` tự xóa.
- `RATE_LIMIT_ENABLED=false`: 20 VU dùng chung một IP, giới hạn 300 request/phút/IP sẽ chi phối kết quả.
- `COLD=1` chạy khi kết quả widget trong cache đã hết hạn (> 10 phút sau lần chạy dashboard cuối); ngưỡng
  `dashboard_cold_loads count==4` bảo đảm cả 4 lượt mở đều không lấy widget nào từ cache.

## Kết quả 2026-11-09 (máy dev)

Môi trường: Windows 11, Intel i5-12500H (12 nhân/16 luồng), 23,7 GB RAM; API + worker build (`node dist/…`, 1 tiến
trình mỗi loại) chạy trên host; PostgreSQL 16.15 / Redis 7 / SeaweedFS trong Docker Desktop (16 CPU, 11,5 GB),
cấu hình mặc định (`shared_buffers` 128 MB, `work_mem` 4 MB). Máy cùng lúc chạy container của dự án khác ⇒ có nhiễu.

Import: `orders` 2.000.000 dòng trong **152 s** (upload + parse + ghi data plane + profiling/quality trong worker).

### Tải hỗn hợp 20 VU, 3 phút (`k6 run k6/load.mjs`)

| Kịch bản | VU | Số request | p50 | p95 | p99 | max | Ngưỡng | Kết quả |
|---|---|---|---|---|---|---|---|---|
| Truy vấn cache-miss (khoảng ngày ngẫu nhiên 7–669 ngày, 5 dạng truy vấn) | 8 | 1.143 | 245 ms | **494 ms** | 742 ms | 1,59 s | p95 ≤ 3 s | ✅ |
| Truy vấn cache-hit | 8 | 1.331 | 61 ms | **210 ms** | 299 ms | 750 ms | p95 ≤ 300 ms | ✅ |
| Mở dashboard 10 widget (chi tiết + 10 widget song song; phần lớn từ cache) | 4 | 4 × ~110 lượt | 307 ms | **595 ms** | 1,69 s | 1,76 s | p95 ≤ 5 s | ✅ |
| Lỗi HTTP | – | 4.853 | | | | | < 1 % | ✅ 0 % |

Tỷ lệ cache thực tế (theo trường `cached` của response): cache-miss 0,26 % trúng (3/1.143 khoảng ngày trùng ngẫu nhiên),
cache-hit 99,92 %. Lần chạy đầu (khoảng ngày ≤ 127 ngày): miss p95 317 ms, hit p95 173 ms, dashboard p95 548 ms.

### Dashboard lạnh (`COLD=1`): 4 người mở cùng lúc, trong khi 8 VU gửi truy vấn cache-miss

| Chỉ số | p50 | p95 | max | Ngưỡng | Kết quả |
|---|---|---|---|---|---|
| Mở dashboard, cả 10 widget tính từ database (4/4 lượt) | 2,05 s | 2,20 s | **2,21 s** | ≤ 5 s | ✅ |
| Một widget tính từ database (40 lần) | 845 ms | 1,49 s | 1,55 s | – | |
| Truy vấn cache-miss chạy song song | 138 ms | 274 ms | 1,61 s | p95 ≤ 3 s | ✅ |

## Nhận xét

- Mọi ngưỡng đạt với biên rộng (cache-miss p95 ≈ 1/6 ngưỡng). Truy vấn chậm nhất là các widget quét toàn bộ lịch sử
  (2 triệu dòng, join `customer`) ≈ 1,5 s khi 4 người mở dashboard lạnh cùng lúc.
- Đây là số trên máy dev với PostgreSQL mặc định; production (VPS 4 vCPU/8 GB theo PHASE6_AUDIT §7) cần chạy lại cùng
  kịch bản trước pilot (`docs/PILOT.md` E2). Statement timeout truy vấn là 15 s – còn xa.
- Chưa đo: nhiều tổ chức lớn cùng lúc, import đồng thời với truy vấn, hỏi đáp AI/điều tra (phụ thuộc độ trễ OpenAI –
  đo trong eval model thật).
