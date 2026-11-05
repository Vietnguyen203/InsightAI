# InsightAI

AI-powered Business Intelligence & Data Analytics SaaS: upload CSV/Excel → kiểm tra & làm sạch dữ liệu → định nghĩa KPI trên Semantic Layer → hỏi đáp bằng ngôn ngữ tự nhiên với câu trả lời truy vết được.

> InsightAI không phải chatbot nối vào database. Data Quality Engine và Semantic Layer là nền tảng; AI là giao diện.

## Trạng thái

**Phase 6D:** engine phân tích tất định (so sánh kỳ, phân rã đóng góp + mix/rate, xu hướng, phân phối, bất thường) chạy trên Semantic Query Engine theo quyền người dùng. **Phase 6A:** dashboard – tạo/chia sẻ (riêng tư/cả tổ chức), widget chạy theo quyền người xem, chỉnh bố cục, ghim câu trả lời AI và thẻ KPI. **Phase 6B:** sẵn sàng production – Docker image, compose production (Caddy HTTPS, Redis có mật khẩu), backup/restore có global roles, SSE heartbeat/timeout, cài đặt chia sẻ dữ liệu AI theo tổ chức (mặc định chỉ metadata); xem [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). **Phase 5 hoàn tất:** hỏi đáp AI – tool calling trên semantic layer, số liệu do server điền, hội thoại + SSE, quota (5a); trang Hỏi đáp AI với biểu đồ, bảng, nguồn, SQL và bộ eval 57 câu (5b). Cần `OPENAI_API_KEY` + `OPENAI_MODEL`; eval: `AI_EVAL=true pnpm test:int test/ai-eval.int.test.ts`. **Phase 4 hoàn tất:** semantic model – entity, dimension, measure, relationship, kiểm tra và publish (4a); query engine an toàn – chống đếm trùng, kiểm tra SQL bằng parser PostgreSQL, access policy, cache, lịch sử truy vấn (4b); metric có version (simple/ratio/derived), so sánh kỳ trước, synonym, catalog/KPI API (4c); giao diện Mô hình & KPI (4d). **Phase 3 hoàn tất:** Đã có: expression DSL, quality rule cho 5 nhóm kiểm tra, quality check tự động, điểm và báo cáo chất lượng (3a); cleaning – gợi ý theo rule, 10 loại thao tác, preview, áp dụng thành version mới, kiểm tra lại, so sánh và kích hoạt/rollback version (3b); giao diện chất lượng, làm sạch và phiên bản (3c). Trước đó: nền tảng (Phase 1); xác thực, organization/tenant, RBAC, link mời, audit log – backend (2a) và giao diện (2b). Dataset & import CSV/XLSX với suy luận kiểu, hồ sơ dữ liệu và giao diện dataset (2c, 2d). **Phase 2 hoàn tất.** Xem [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

## Cấu trúc

```
apps/api            NestJS: src/main.ts (HTTP) + src/worker.ts (BullMQ worker)
apps/web            React + Vite + Tailwind + shadcn/ui
packages/contracts  Zod schemas dùng chung (api, web, LLM tools)
docker/compose.yml  PostgreSQL 16, Redis 7, SeaweedFS (S3 API)
docs/               Kiến trúc & quyết định
```

## Yêu cầu

- Node.js ≥ 24, pnpm 10 (`corepack enable`)
- Docker (Docker Desktop trên Windows/macOS)

## Chạy local

```bash
cp .env.example .env                        # rồi đặt JWT_ACCESS_SECRET ngẫu nhiên (≥ 32 ký tự)
pnpm install
pnpm infra:up                               # postgres :15432, redis :16379, s3 :18333
pnpm storage:bootstrap                      # tạo bucket S3 (idempotent)
pnpm db:bootstrap                           # tạo DB roles (idempotent)
pnpm db:migrate                             # Prisma migrations (schema app)
pnpm --filter @insightai/contracts build
pnpm --filter @insightai/api dev            # http://localhost:3100
pnpm --filter @insightai/api dev:worker
pnpm --filter @insightai/web dev            # http://localhost:5173
```

- Swagger UI: http://localhost:3100/docs (tắt ở production)
- Health: `GET /health/live`, `GET /health/ready`
- Cổng host khác mặc định để không đụng project khác; đổi bằng `INSIGHTAI_POSTGRES_PORT`, `INSIGHTAI_REDIS_PORT`, `INSIGHTAI_S3_PORT`

## Kiểm thử

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit tests (không cần Docker)
pnpm test:int    # integration tests: cần infra:up + db:bootstrap + storage:bootstrap + db:migrate
PERF_TEST=true PERF_ROWS=500000 pnpm test:int   # (tùy chọn) đo hiệu năng import + profiling
```

Integration tests tạo và xóa các bảng/schema/role fixture của riêng chúng (`app.rls_spike`, `t_spike*`), không đụng dữ liệu khác.

## Tài liệu

| Tài liệu                                                  | Nội dung                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)                   | Phạm vi MVP, kiến trúc tổng thể, module, luồng chính, bảo mật              |
| [SEMANTIC_LAYER_DESIGN.md](docs/SEMANTIC_LAYER_DESIGN.md) | Nghiên cứu MetricFlow/Cube/Superset, thiết kế semantic layer, tích hợp LLM |
| [DATA_QUALITY_DESIGN.md](docs/DATA_QUALITY_DESIGN.md)     | Type detection, rule engine, score, cleaning, versioning                   |
| [DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md)             | ERD, constraints, indexes, multi-tenancy, DB roles                         |
| [API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)         | Xác thực, tenant header, lỗi RFC 7807, danh sách endpoint                  |
| [DECISIONS.md](docs/DECISIONS.md)                         | Quyết định kiến trúc & câu hỏi mở                                          |
| [DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)           | Kế hoạch theo phase                                                        |
| [FUTURE_ROADMAP.md](docs/FUTURE_ROADMAP.md)               | Ngoài phạm vi MVP                                                          |
