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

## 6. Phân trang

Cursor-based: `?limit=50&cursor=<nextCursor>` → `{ items: [...], nextCursor: string | null }`.
