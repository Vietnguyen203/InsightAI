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

`code` ổn định, frontend dùng để dịch: `VALIDATION_FAILED` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN` (403) · `NOT_FOUND` (404) · `CONFLICT` (409) · `QUERY_REJECTED` (422) · `RATE_LIMITED` (429) · `EXTERNAL_SERVICE_ERROR` (502) · `INTERNAL_ERROR` (500, không lộ chi tiết nội bộ).

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

## 6. Phân trang

Cursor-based: `?limit=50&cursor=<nextCursor>` → `{ items: [...], nextCursor: string | null }`.
