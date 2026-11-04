# InsightAI – API Documentation

Swagger/OpenAPI (sinh từ code, luôn đúng với bản đang chạy): `http://localhost:3100/docs` · JSON: `/docs-json` (tắt ở production).
Tài liệu này mô tả các quy ước mà Swagger không thể hiện rõ: xác thực, tenant, lỗi, phân trang.

## 1. Quy ước chung

| Mục | Quy ước |
|---|---|
| Base path | `/api/v1` (health ở `/health/*`, ngoài prefix) |
| Định dạng | JSON; thời gian ISO 8601 UTC |
| Validation | Zod schema trong `packages/contracts` – cùng một schema cho backend, frontend và Swagger |
| Request id | Gửi `X-Request-Id` (8–64 ký tự `[A-Za-z0-9-]`) hoặc server tự sinh; luôn trả lại ở response header và trong body lỗi |
| Rate limit | 300 req/phút/IP mặc định; `register`/`login` 10/phút; `refresh` 30/phút; xem/nhận link mời 20/phút. Lưu trên Redis (đúng khi chạy nhiều instance) |

## 2. Lỗi (RFC 7807)

Mọi lỗi trả `Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "Request validation failed",
  "instance": "/api/v1/auth/register",
  "requestId": "4f0c…",
  "errors": [{ "path": "email", "message": "Invalid email address" }]
}
```

`code` ổn định, frontend dùng để dịch: `VALIDATION_FAILED` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN` (403) · `NOT_FOUND` (404) · `CONFLICT` (409) · `QUERY_REJECTED` (422) · `RATE_LIMITED` (429) · `AI_UNAVAILABLE` (503) · `EXTERNAL_SERVICE_ERROR` (502) · `INTERNAL_ERROR` (500, không lộ chi tiết nội bộ).

## 3. Xác thực

```
POST /auth/register | /auth/login  → 200/201 { accessToken, expiresIn, user }  + Set-Cookie: insightai_rt
GET  /api/v1/...  Authorization: Bearer <accessToken>
POST /auth/refresh  (cookie + X-Requested-With: insightai) → token mới + cookie mới (rotation)
POST /auth/logout   (cookie + X-Requested-With: insightai) → 204, thu hồi cả phiên
```

- **Access token**: JWT HS256, 15 phút, chỉ chứa `sub` (user id) và `sid` (session). Không chứa org/quyền: quyền được tra DB mỗi request nên đổi role/xóa thành viên có hiệu lực ngay.
- **Refresh token**: chuỗi ngẫu nhiên 256-bit trong cookie `insightai_rt` (`HttpOnly`, `SameSite=Strict`, `Secure` ở production, `Path=/api/v1/auth`), DB chỉ lưu SHA-256. Mỗi lần refresh sinh token mới; dùng lại token cũ (sau 10 giây ân hạn cho trường hợp 2 tab) ⇒ thu hồi toàn bộ phiên và ghi audit `auth.refresh_reuse_detected`.
- **CSRF**: endpoint dùng cookie (`refresh`, `logout`) bắt buộc header `X-Requested-With: insightai`.
- **Frontend**: giữ access token trong bộ nhớ (không localStorage); khi tải trang hoặc nhận 401 thì gọi `refresh` (single-flight).
- Đăng nhập sai mật khẩu và email không tồn tại trả cùng thông báo và thời gian xử lý tương đương.

## 4. Tenant (organization)

Route nghiệp vụ yêu cầu header **`X-Organization-Id: <uuid>`**. Server kiểm tra caller là thành viên ACTIVE và có đủ permission của route; không phải thành viên ⇒ 403 (giống hệt khi org không tồn tại). Danh sách org của user: `GET /auth/me`.

Permission theo role (nguồn: `packages/contracts/src/iam.ts`):

| Permission | owner | admin | analyst | viewer |
|---|:-:|:-:|:-:|:-:|
| `org:read`, `member:read`, `dataset:read`, `quality:read`, `semantic:read`, `semantic:query`, `dashboard:read` | ✓ | ✓ | ✓ | ✓ |
| `dataset:write`, `quality:write`, `quality:apply_cleaning`, `semantic:write`, `dashboard:write` | ✓ | ✓ | ✓ | |
| `org:update`, `member:manage`, `invitation:manage`, `audit:read`, `semantic:publish` | ✓ | ✓ | | |

Quy tắc thêm: chỉ owner được cấp/thu hồi role owner hoặc mời owner; org luôn còn ≥ 1 owner.

## 5. Endpoints (Phase 2a)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| POST | `/auth/register` | public | Tạo tài khoản + org mới (`organizationName`) hoặc tham gia qua `invitationToken` |
| POST | `/auth/login` | public | |
| POST | `/auth/refresh` | cookie + CSRF header | |
| POST | `/auth/logout` | cookie + CSRF header | |
| GET | `/auth/me` | đăng nhập | User + danh sách membership |
| POST | `/organizations` | đăng nhập | Tạo thêm org (caller là owner) |
| GET | `/organizations/current` | thành viên | Org hiện tại + role + permissions của caller |
| PATCH | `/organizations/current` | `org:update` | Đổi tên, timezone, locale |
| GET | `/members` | `member:read` | |
| PATCH | `/members/:membershipId` | `member:manage` | Đổi role |
| DELETE | `/members/:membershipId` | `member:manage` | Xóa thành viên |
| POST | `/invitations` | `invitation:manage` | Tạo link mời; `token` chỉ trả về **một lần** |
| GET | `/invitations` | `invitation:manage` | Link còn hiệu lực |
| DELETE | `/invitations/:id` | `invitation:manage` | Thu hồi |
| POST | `/invitations/preview` | public | `{ token }` → tên org, role, hạn |
| POST | `/invitations/accept` | đăng nhập | `{ token }` → tham gia org |
| GET | `/audit-logs?limit&cursor` | `audit:read` | Phân trang cursor, mới nhất trước |

Token mời luôn đi trong body (không đặt trên URL API) để không lọt vào access log. Link phía frontend: `/invite/<token>`.

## 5b. Datasets & import (Phase 2c)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/datasets` | `dataset:read` | Danh sách (không gồm dataset đã lưu trữ) kèm version đang dùng và import gần nhất |
| POST | `/datasets` | `dataset:write` | Tạo dataset rỗng `{ name, description? }` |
| GET | `/datasets/:id` | `dataset:read` | Chi tiết: cột của version đang dùng (kiểu, độ tin cậy, số giá trị lỗi), danh sách version |
| PATCH | `/datasets/:id` | `dataset:write` | Đổi tên/mô tả |
| POST | `/datasets/:id/archive` | `dataset:write` | Lưu trữ (ẩn). **Không xóa** dữ liệu hay version |
| GET | `/datasets/:id/rows?versionId&after&limit` | `dataset:read` | Xem dữ liệu, phân trang keyset theo `rowId` (≤ 200 dòng). Giá trị trả về dạng text đúng như PostgreSQL hiển thị |
| POST | `/datasets/:id/imports` | `dataset:write` | `multipart/form-data`: `file` (.csv/.xlsx, ≤ 100 MB) + `options` (JSON). Trả 202 + import job |
| POST | `/datasets/:id/reimports` | `dataset:write` | Import lại file đã tải lên với options khác (vd. `columnTypes`) |
| GET | `/datasets/:id/imports` | `dataset:read` | Lịch sử import |
| GET | `/datasets/:id/profile?versionId` | `dataset:read` | Hồ sơ dữ liệu từng cột (`status`: PENDING → RUNNING → SUCCEEDED/FAILED) |
| POST | `/datasets/:id/profile?versionId` | `dataset:write` | Tính lại hồ sơ dữ liệu (409 nếu đang chạy) |
| GET | `/imports/:id` | `dataset:read` | Trạng thái một import (poll tới khi `SUCCEEDED`/`FAILED`) |

`options`: `delimiter` (`, ; \t |`, tự nhận nếu bỏ trống) · `encoding` (UTF-8/UTF-16 BOM tự nhận; `windows-1258`, `windows-1252`) · `hasHeader` (mặc định true) · `sheetName` (XLSX) · `locale` (`vi`: `1.234,5`, `dd/MM/yyyy`; `en`: `1,234.5`, `MM/dd/yyyy`; mặc định theo tổ chức; chỉ áp dụng cho CSV) · `columnTypes` (`{ "ten_cot": "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "TIMESTAMP" }`).

Import thất bại vì dữ liệu (`error.code`: `EMPTY_FILE`, `TOO_MANY_ROWS` (> 2 triệu), `TOO_MANY_COLUMNS` (> 300), `MALFORMED_FILE`, `UNSAFE_ARCHIVE`, `SHEET_NOT_FOUND`, `UNKNOWN_COLUMN`, `UNSUPPORTED_FORMAT`) không retry; lỗi hệ thống retry 3 lần rồi báo `INTERNAL_ERROR`. Import thất bại không thay đổi version đang dùng.

## 5c. Data quality (Phase 3a)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/datasets/:id/quality-rules` | `quality:read` | Rule của dataset (hệ thống + người dùng) |
| POST | `/datasets/:id/quality-rules` | `quality:write` | Tạo rule: `{ name, definition, severity, weight, threshold, enabled }` |
| PATCH | `/quality-rules/:ruleId` | `quality:write` | Sửa (rule hệ thống: chỉ tên, mức độ, trọng số, ngưỡng, bật/tắt) |
| DELETE | `/quality-rules/:ruleId` | `quality:write` | Xóa rule người dùng (409 với rule hệ thống) |
| POST | `/datasets/:id/expressions/validate` | `quality:read` | `{ expr }` → `{ valid, type, columns }` hoặc `{ valid: false, error: { message, position } }` |
| POST | `/datasets/:id/quality-checks?versionId` | `quality:write` | Chạy check (202). Trả check đang chạy nếu đã có |
| GET | `/datasets/:id/quality-checks` | `quality:read` | Lịch sử check (mới nhất trước) |
| GET | `/quality-checks/:checkId` | `quality:read` | Điểm, điểm theo nhóm, kết quả từng rule (lỗi trước) |
| GET | `/quality-checks/:checkId/results/:resultId/issues?after&limit` | `quality:read` | Dòng lỗi mẫu (tối đa 100/rule): `rowId`, cột, giá trị, giá trị gốc |

`definition.type`: `not_null` (completeness) · `unique`, `duplicate_rows` (uniqueness) · `type_castable`, `regex`, `allowed_values`, `range`, `length` (validity) · `expression` (consistency) · `foreign_key` (referential integrity). `duplicate_rows` và `type_castable` chỉ do hệ thống tạo.

Điểm: `pass_rate = 1 − lỗi/đã kiểm`; trong mỗi nhóm lấy trung bình có trọng số (`weight × hệ số mức độ`: info 0,5 · warning 1 · error 2); điểm tổng là trung bình các nhóm có rule. `qualityStatus`: FAILED nếu có rule mức *error* không đạt ngưỡng, WARNING nếu có rule *warning* không đạt, ngược lại PASSED.

## 5d. Data cleaning & versions (Phase 3b)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/datasets/:id/cleaning/suggestions?versionId` | `quality:read` | Gợi ý theo rule (không tự áp dụng): `{ versionId, qualityCheckId, suggestions: [{ id, operation, rationale: { code, message, params }, estimatedRows }] }` |
| POST | `/datasets/:id/cleaning/preview` | `quality:write` | `{ sourceVersionId?, operations }` → số dòng đổi/xóa của **từng** thao tác (trên toàn bảng), số dòng trước/sau, cột sau cleaning, mẫu 50 dòng trước → sau. Chỉ đọc |
| POST | `/datasets/:id/cleaning-jobs` | `quality:apply_cleaning` | Áp dụng (202) → job nền tạo **version mới chưa kích hoạt**, rồi profiling + quality check (`trigger: CLEANING`) |
| GET | `/datasets/:id/cleaning-jobs` | `quality:read` | Lịch sử cleaning (thao tác + số dòng ảnh hưởng) |
| GET | `/cleaning-jobs/:jobId` | `quality:read` | Trạng thái job, `targetVersionId` khi xong |
| POST | `/datasets/:id/versions/:versionId/activate` | `dataset:write` | Đặt version đang dùng. Kích hoạt version cũ = rollback (không xóa gì) |
| GET | `/datasets/:id/versions/compare?base&target` | `dataset:read` | So sánh: dòng bị xóa/thêm/đổi (theo `_row_id`), từng cột (đổi kiểu, số dòng đổi), kết quả từng rule ở check gần nhất của mỗi bên, điểm chất lượng |

`operations` (tối đa 30, chạy theo thứ tự; tên cột là tên hiện tại – sau `rename_column` dùng tên mới):

| `type` | Tham số | Ghi chú |
|---|---|---|
| `trim_whitespace` | `columns[]`, `collapseInner` | Cột văn bản; bỏ cả khoảng trắng không ngắt (NBSP); chuỗi rỗng → trống |
| `change_case` | `columns[]`, `mode`: `lower` · `upper` · `title` | Cột văn bản |
| `replace_values` | `column`, `mapping: [{ from, to }]` (`to` có thể `null`), `caseSensitive` | Cột văn bản, tối đa 500 cặp |
| `fill_null` | `column`, `strategy`: `constant` · `mean` · `median` · `mode` · `previous`, `value` | `mean`/`median` chỉ cột số (median chính xác, không qua float); `previous` theo thứ tự dòng |
| `cast_column` | `column`, `targetType`, `locale?` | Đọc lại **giá trị gốc trong file** với định dạng `vi`/`en` |
| `parse_date` | `column`, `formats[]` | Giữ ngày hợp lệ, thử các định dạng theo thứ tự cho giá trị trống/sai: `yyyy-MM-dd`, `dd/MM/yyyy`, `MM/dd/yyyy`, `dd-MM-yyyy`, `dd.MM.yyyy`, `yyyy/MM/dd`, `yyyyMMdd` |
| `drop_rows` | `condition` (Expression DSL) **hoặc** `ruleId` | Xóa dòng có điều kiện đúng (NULL giữ lại) / dòng vi phạm một rule cấp dòng |
| `deduplicate` | `keyColumns[]` (trống = cả dòng), `keep`: `first` · `last` | Khóa thiếu giá trị không bị coi là trùng (như rule `unique`) |
| `rename_column` | `column`, `newName` | `newName`: chữ thường, số, `_` |
| `drop_column` | `column` | Không xóa được cột cuối cùng |

Thao tác không hợp lệ → 400 với `errors[0].path = "operations.<n>"`. Dữ liệu không chuyển được khi preview → 422 `QUERY_REJECTED`. Job lỗi do dữ liệu: `error.code = CLEANING_FAILED` (không retry); lỗi hệ thống retry 3 lần rồi `INTERNAL_ERROR`. `rationale.code` của gợi ý: `TRIM_WHITESPACE`, `UNIFY_VARIANTS`, `PARSE_DATES`, `FILL_MEDIAN`, `REMOVE_DUPLICATE_ROWS`, `REMOVE_DUPLICATE_KEYS`, `DROP_FAILING_ROWS`.

`DatasetVersion` có thêm `parentVersionId`, `cleaningJobId`, `qualityStatus`, `qualityScore`.

## 5e. Semantic models (Phase 4a)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/semantic-models` | `semantic:read` | Danh sách model (trạng thái, revision, có thay đổi nháp, kết quả kiểm tra) |
| POST | `/semantic-models` | `semantic:write` | `{ key, name, description }` |
| GET / PATCH | `/semantic-models/:id` | `semantic:read` / `semantic:write` | Chi tiết (entity, dimension, measure, relationship, báo cáo kiểm tra) / sửa tên, mô tả |
| POST | `/semantic-models/:id/entities` | `semantic:write` | `{ key, name, description, datasetId, primaryKey[] }` |
| PATCH / DELETE | `/semantic-entities/:id` | `semantic:write` | Xóa entity xóa luôn dimension, measure, relationship của nó |
| POST | `/semantic-entities/:id/dimensions` | `semantic:write` | `{ key, name, type: CATEGORICAL\|TIME, expr, granularities?, hidden }` |
| PATCH / DELETE | `/semantic-dimensions/:id` | `semantic:write` | |
| POST | `/semantic-entities/:id/measures` | `semantic:write` | `{ key, name, agg: sum\|count\|count_distinct\|avg\|min\|max, expr }` (`expr` bỏ trống chỉ với `count`) |
| PATCH / DELETE | `/semantic-measures/:id` | `semantic:write` | |
| POST | `/semantic-models/:id/relationships` | `semantic:write` | `{ fromEntityId, toEntityId, joinColumns: [{ from, to }], cardinality: MANY_TO_ONE\|ONE_TO_ONE, preferred }` |
| PATCH / DELETE | `/semantic-relationships/:id` | `semantic:write` | |
| POST | `/semantic-models/:id/validate` | `semantic:write` | Kiểm tra bản nháp, lưu báo cáo |
| POST | `/semantic-models/:id/publish` | `semantic:publish` | Kiểm tra lại rồi đóng băng thành revision mới; 409 nếu có lỗi (báo cáo vẫn được lưu) |

Mọi thao tác ghi trả về toàn bộ model sau khi đổi. `key` (`^[a-z][a-z0-9_]{0,62}$`) không đổi sau khi tạo; dimension và measure dùng chung một không gian tên trong mỗi entity. `expr` là Expression DSL trên tên cột của dataset. Mỗi thay đổi đặt `hasDraftChanges = true`, `validationStatus = UNVALIDATED`.

Mã lỗi kiểm tra (`validationReport.issues[].code`): lỗi – `MODEL_EMPTY`, `DATASET_UNAVAILABLE`, `COLUMN_NOT_FOUND`, `EXPRESSION_INVALID`, `TIME_DIMENSION_TYPE`, `MEASURE_TYPE`, `PRIMARY_KEY_NULL`, `PRIMARY_KEY_DUPLICATE`, `JOIN_TYPE_MISMATCH`, `RELATIONSHIP_NOT_UNIQUE`, `RELATIONSHIP_AMBIGUOUS`; cảnh báo – `RELATIONSHIP_ORPHANS`, `RELATIONSHIP_CYCLE`, `DATASET_QUALITY_FAILED`, `DATA_CHECK_FAILED`.

## 5f. Semantic query & access policies (Phase 4b)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| POST | `/semantic-query` | `semantic:query` | Chạy Semantic Query IR trên bản đã publish → `{ columns, rows, truncated, dateRange, modelRevision, cached, policiesApplied }` |
| POST | `/semantic-query/compile` | `semantic:write` | Trả SQL + tham số + cột, không chạy |
| GET | `/semantic-models/:id/access-policies` | `semantic:read` | Danh sách policy |
| POST | `/semantic-models/:id/access-policies` | `semantic:publish` | `{ name, roles[], memberAccess?: { include?, exclude? }, rowFilter?: { entity, expr }, enabled }` |
| PATCH / DELETE | `/semantic-access-policies/:id` | `semantic:publish` | Có hiệu lực ngay (không cần publish) |

IR (Phase 4b truy vấn **measure**; metric ở 4c): `{ model, measures: ["entity.measure"] (1–5), dimensions?: ["entity.dimension"] (≤ 3), timeDimension?: { dimension, granularity?: day|week|month|quarter|year, dateRange?: { preset } | { from, to } }, filters?: [{ member, op, values? }], orderBy?: [{ member, dir }], limit? (≤ 1000, mặc định 100) }`.
- `dateRange.preset`: `today, yesterday, this_week, last_week, this_month, last_month, last_7_days, last_30_days, last_90_days, this_quarter, last_quarter, this_year, last_year` – tính ở server theo múi giờ tổ chức; `{ from, to }` là ngày (tính cả hai đầu).
- `filters[].op`: `eq, neq, in, not_in, gt, gte, lt, lte, contains, is_null, not_null`; chỉ lọc theo dimension; giá trị luôn được bind thành tham số.
- Giá trị trả về là chuỗi đúng như PostgreSQL hiển thị (số thập phân chính xác, ngày ISO).
- Bị từ chối → 422 `QUERY_REJECTED`, lý do ở `errors[0].path = "reason.<CODE>"`: `UNKNOWN_MODEL`, `UNKNOWN_MEMBER`, `DUPLICATE_MEMBER`, `NOT_A_TIME_DIMENSION`, `GRANULARITY_NOT_ALLOWED`, `MEASURE_FILTER_NOT_SUPPORTED`, `INVALID_FILTER`, `ORDER_NOT_IN_RESULT`, `DATA_UNAVAILABLE`, `FANOUT_JOIN`, `NOT_REACHABLE`, `AMBIGUOUS_JOIN_PATH`, `POLICY_NOT_ENFORCEABLE`, `SQL_REJECTED`, `TIMEOUT`.

## 5g. Metrics, synonyms & catalog (Phase 4c)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET / POST | `/semantic-models/:id/metrics` | `semantic:read` / `semantic:write` | Danh sách (bản publish + bản nháp + synonym) / tạo metric kèm bản nháp v1: `{ key, label, businessDefinition, unit, format: number\|currency\|percent, definition }` |
| GET | `/metrics/:id` | `semantic:read` | Metric và mọi version |
| POST | `/metrics/:id/versions` | `semantic:write` | Bản nháp mới (409 nếu đã có nháp) |
| PATCH / DELETE | `/metric-versions/:id` | `semantic:write` | Chỉ với bản nháp (409 khi đã publish); xóa bản nháp duy nhất thì xóa luôn metric (trả `null`) |
| POST | `/metric-versions/:id/publish` | `semantic:publish` | Lập kế hoạch thử trên model đã publish (422 với lý do), rồi publish; version publish trước chuyển `DEPRECATED` |
| POST | `/metrics/:id/deprecate` · `/restore` | `semantic:publish` | Metric ngừng dùng rời catalog nhưng vẫn truy vấn được |
| GET / POST | `/semantic-models/:id/synonyms` | `semantic:read` / `semantic:write` | `{ member: "<metric key>" \| "entity.dimension", phrase }`; một cụm từ (không phân biệt hoa thường, dấu) chỉ trỏ một member (409) |
| DELETE | `/semantic-synonyms/:id` | `semantic:write` | |
| GET | `/catalog?model=<key>` | `semantic:query` | Metric (đang dùng, đã publish) và dimension (không ẩn) mà người gọi được phép truy vấn, kèm synonym. `timeDimension` của metric RATIO/DERIVED suy ra từ các metric thành phần khi chúng dùng chung một time dimension |

`definition`: `{ type: "SIMPLE", measure: "entity.measure", filters?: [như filter của query], timeDimension?: "entity.dimension" }` · `{ type: "RATIO", numerator: "<key>", denominator: "<key>" }` · `{ type: "DERIVED", expr: "<DSL trên key metric>" }`.

Truy vấn metric: `POST /semantic-query` với `metrics: ["<key>"]` (có thể kèm `measures`, tổng ≤ 5). `timeDimension.dimension` bỏ trống = time dimension mặc định của metric; `compareTo: previous_period | same_period_last_year` (cần `dateRange`, không dùng với `granularity`) thêm cột kỳ trước (`comparison: true`). Kết quả có `compareRange`, `metrics: [{ key, version }]`, cột có `unit`, `format`. Policy ẩn metric bằng mẫu `metric:<key>` / `metric:*`. Mã lý do mới: `UNKNOWN_METRIC`, `METRIC_CYCLE`, `INVALID_METRIC`, `TIME_DIMENSION_REQUIRED`, `TIME_DIMENSION_AMBIGUOUS`, `COMPARE_NOT_SUPPORTED`.

## 5h. AI hỏi đáp (Phase 5a)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/ai/status` | `semantic:query` | `{ enabled, dailyLimit, remainingToday }` |
| POST | `/ai/ask` | `semantic:query` | `{ model, question }` (câu đầu) hoặc `{ conversationId, question }` (follow-up). Trả `text/event-stream` |
| GET | `/ai/conversations` | `semantic:query` | 50 hội thoại gần nhất **của chính người gọi** |
| GET / DELETE | `/ai/conversations/:id` | `semantic:query` | Chi tiết (messages kèm `answer`) / xóa; hội thoại của người khác → 404 |

Lỗi trước khi stream là RFC 7807 thường: 503 `AI_UNAVAILABLE` (chưa cấu hình OpenAI), 429 `RATE_LIMITED` (hết quota ngày của org), 404 (model chưa publish / hội thoại). Sự kiện SSE (`data: <JSON>`): `conversation {conversationId}` → `stage {understanding|planning|executing|explaining}` → `result {answer}` hoặc `error {code: AI_PROVIDER_ERROR|INTERNAL_ERROR}` → `done {messageId}`.

`answer`: `status ANSWERED|CLARIFICATION|CANNOT_ANSWER`, `narrative` (số liệu do server điền), `query` (IR), `result` (như `/semantic-query`, có `queryHistoryId`), `chart {type: kpi|line|bar|table, x, series}`, `clarification {question, options}`, `provenance {interpretedAs, queryHistoryId, modelRevision, metrics[{key, version, label}], datasets[{id, name, versionNo, qualityScore}], policiesApplied}`.

## 6. Phân trang

Cursor-based: `?limit=50&cursor=<nextCursor>` → `{ items: [...], nextCursor: string | null }`.
