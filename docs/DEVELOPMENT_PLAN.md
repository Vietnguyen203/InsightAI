# InsightAI – Development Plan

> Không cố định thời gian; ước lượng sau mỗi phase dựa trên khối lượng thực tế. Mỗi phase kết thúc bằng báo cáo (Rule 8) và chỉ chuyển phase khi được xác nhận.

## Definition of Done (mọi phase)
Chức năng chạy đúng · không phá chức năng cũ · unit + integration test cho logic quan trọng xanh trong CI · `tsc --strict` không lỗi, không `any` không có lý do · docs cập nhật · hướng dẫn chạy/kiểm thử · vấn đề tồn đọng ghi rõ.

---

## Phase 0 – Research & Architecture ✅ (đã xác nhận 2026-11-03)
Deliverables: `ARCHITECTURE.md`, `SEMANTIC_LAYER_DESIGN.md`, `DATA_QUALITY_DESIGN.md`, `DATABASE_DESIGN.md`, `DECISIONS.md`, `DEVELOPMENT_PLAN.md`, `FUTURE_ROADMAP.md`.
Đầu ra cần: trả lời Open questions trong DECISIONS.md.

## Phase 1 – Project Foundation ✅ (chờ xác nhận; quyết định D-17…D-19, kết quả spike RLS ở D-06)
Mục tiêu: khung chạy được end-to-end, chưa có nghiệp vụ.
- pnpm workspace; `apps/api` (NestJS, strict TS, ESLint + Prettier), `apps/web` (Vite React TS, Tailwind, shadcn/ui, Router, TanStack Query, dark mode, layout dashboard trống, i18n skeleton), `packages/contracts` (Zod).
- `docker/compose.yml`: postgres 16, redis 7, SeaweedFS (S3); `.env.example`; config validate bằng Zod khi boot.
- Platform: pino logger + requestId, global exception filter (problem+json), Swagger tại `/docs`, health `/health/live|ready`, Prisma client + migration đầu (extensions, schema `app`, roles DB), `pg` pools (analytics, ingest), BullMQ module + worker entrypoint với 1 job "ping", S3 storage service.
- **Spike** (time-boxed, kết quả ghi vào DECISIONS): Prisma + RLS (`set_config` trong transaction qua client extension) – đo overhead; `SET LOCAL ROLE` data plane.
- CI GitHub Actions: install, lint, typecheck, test (Postgres/Redis service container), build.
- Test: health integration test; config validation unit test; RLS spike test (tenant A không đọc được tenant B).
- Rủi ro: Prisma + RLS; Windows dev env (dùng Docker cho mọi service).

## Phase 2 – Auth, Organization, Data Management
Chia lát: **2a** danh tính & tenant (backend) ✅ · **2b** UI auth/org/thành viên ✅ · **2c** dataset, upload, import worker, type inference, preview ✅ · **2d** profiling + UI dataset ✅. Phase 2 hoàn tất (chờ xác nhận).
- Auth: register/login/refresh/logout, Argon2id, JWT guard, rate limit `@nestjs/throttler` + Redis storage.
- Organization: tạo org (kèm tenant schema + roles), switch org, members, system roles & permissions, `TenantContext`, `@RequirePermission`.
- Audit module (ghi từ đầu).
- Dataset CRUD + status; upload (multipart, giới hạn kích thước, magic bytes) → S3; import job → worker: parse CSV/XLSX streaming → raw table → type inference → user xác nhận/override schema → typed table v1.
- Preview (phân trang, sort), import history, profiling worker.
- FE: auth pages, org switcher, dataset list/upload wizard (mapping kiểu cột), dataset detail (preview/schema/profile/imports).
- Test: auth flows + token reuse; cross-tenant access (API + DB); parser với file VN (UTF-8 BOM, `;`, `1.234,5`, `dd/MM/yyyy`), XLSX nhiều sheet, file lỗi/độc hại; idempotency import job retry.

## Phase 3 – Data Quality & Cleaning ✅
Chia lát: **3a** expression DSL, rule, quality check, điểm, báo cáo (backend) ✅ · **3b** cleaning: gợi ý theo rule, thao tác, preview, áp dụng → version mới, re-validate, kích hoạt/rollback version ✅ · **3c** giao diện chất lượng & cleaning ✅ (tab Chất lượng, Làm sạch, Phiên bản trong trang dataset). (Gợi ý bằng AI → Phase 5, D-35.)
- Expression DSL (parser, type-checker, SQL compiler) – shared kernel, test kỹ.
- Quality rules CRUD (5 dimension), system rules tự sinh, quality worker (batch scan), score, report API (tổng quan/cột/bản ghi), export lỗi.
- Cleaning: rule-based suggestions, (tùy chọn) AI suggestions qua `llm` module, preview (diff + impact), apply job → version mới → re-validate, so sánh version, activate/rollback.
- FE: quality dashboard, rule editor, issue explorer, cleaning wizard (chọn op → preview → apply), version timeline.
- Test: fixture có số lỗi đã biết cho từng rule; score formula; cleaning op từng loại; re-validate cho kết quả kỳ vọng; ReDoS/regex độc.

## Phase 4 – Semantic Layer & KPI ✅
Chia lát: **4a** semantic model (entity/dimension/measure/relationship), validation, publish snapshot ✅ · **4b** query engine, SQL validator, access policy, cache ✅ · **4c** metric + version lifecycle, synonym, catalog/KPI API ✅ · **4d** giao diện: danh sách/trình soạn model, metric (phiên bản, publish, synonym), chạy thử truy vấn + SQL, thẻ KPI, quyền truy cập ✅.
- CRUD semantic model/entity/dimension/measure/relationship/synonym/access policy; metric + version lifecycle (partial unique PUBLISHED).
- Semantic validation (cột, kiểu, PK uniqueness, relationship uniqueness, graph ambiguity, cycle).
- Query engine: resolver → member authorization → planner (join graph, fan-out rejection, multi-source CTE) → SQL renderer → AST validator → executor (READ ONLY, role, timeout, row limit) → result cache Redis.
- KPI API: `/semantic-query`, `/semantic-query/compile`, `/catalog`; query_history.
- FE: model editor, metric editor với "test query" (hiển thị SQL + kết quả), KPI cards.
- Test: **bộ fixture double-counting** (orders/order_items/products) khẳng định số chính xác và query fan-out bị từ chối; policy injection (user region North chỉ thấy North); SQL validator với payload tấn công (CTE DML, `pg_sleep`, cross-schema); snapshot SQL.

## Phase 5 – AI Analytics ✅
Chia lát: **5a** backend AI – LlmProvider/OpenAI adapter, tool loop, narrative placeholder + number guard, chart rule, conversation, SSE, quota, test với LLM kịch bản ✅ (D-47) · **5b** Ask page (chat, tiến trình, biểu đồ SVG, bảng, nguồn & độ tin cậy, xem SQL, lịch sử hội thoại) + eval set 57 câu (60 lượt hỏi kể cả follow-up) ✅ (D-48). **Phase 5 hoàn tất.**
- `LlmProvider` + adapter (theo D-08), redaction, token accounting, quota/org.
- Pipeline: catalog builder (lọc policy), tool loop (search_catalog, get_dimension_values, run_semantic_query, ask_clarification, cannot_answer), narrative với placeholder + number guard, chart spec rule-based.
- Conversation/messages, SSE streaming, follow-up ("còn tháng trước thì sao?" dùng IR trước làm context).
- FE: Ask page (chat, stage progress, chart, provenance panel "đã hiểu là…", nút xem SQL).
- Test: unit với LLM mock (tool sequences); eval set ≥ 50 câu hỏi (chạy khi có API key, báo cáo accuracy); prompt injection trong câu hỏi và trong giá trị dữ liệu.

## Phase 6 – Visualization & MVP Release
Chia lát theo [PHASE6_AI_ANALYST_DESIGN.md](PHASE6_AI_ANALYST_DESIGN.md) §3 (được duyệt 2026-11-05): **6A** dashboard & workspace ✅ (backend D-49; UI: danh sách, lưới 12 cột, chỉnh bố cục bằng nút, ghim từ Hỏi đáp/KPI) · **6B** production readiness ✅ (D-50) · **6C** investigation core ✅ (D-52) · **6D** analytical engines ✅ (D-51) · **6E** evidence & validation ✅ (D-53) · **6F** narrative & reports ✅ (D-54; báo cáo gắn evidence + UI điều tra) · **6G** AI evaluation – oracle ✅ (D-55, `docs/EVAL_REPORT.md`; eval với model thật chờ API key) · **6H** E2E & pilot ✅ (E2E 6H-1, D-56; k6 2 triệu dòng + kế hoạch pilot 6H-2, D-57, `docs/PERFORMANCE.md`, `docs/PILOT.md`).
- Dashboards + widgets (lưu IR, chạy với quyền người xem), pin từ câu trả lời AI.
- E2E (Playwright) cho luồng chính: upload → quality → cleaning → metric → hỏi → dashboard.
- Security testing (OWASP API Top 10 checklist, tenant isolation suite), performance test (k6: semantic query trên 2M dòng).
- Docker production config, migration strategy, backup, deployment docs, API_DOCUMENTATION hoàn chỉnh.

---

## Tài liệu được cập nhật theo phase
| Tài liệu | Bắt đầu |
|---|---|
| README.md | Phase 0 (khung), cập nhật mỗi phase |
| ARCHITECTURE / DATABASE_DESIGN / SEMANTIC_LAYER_DESIGN / DATA_QUALITY_DESIGN / DECISIONS | Phase 0, cập nhật khi thay đổi |
| API_DOCUMENTATION.md | Phase 2 (khi có endpoint thật; Swagger là nguồn chính, file này mô tả auth, lỗi, quy ước, ví dụ) |
| FUTURE_ROADMAP.md | Liên tục |
