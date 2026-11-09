# InsightAI – Architecture Decision Log

Mỗi quyết định: bối cảnh → quyết định → lý do → hệ quả. Trạng thái: `Proposed` (chờ xác nhận) · `Accepted` · `Superseded`.
Quyết định đánh dấu ⚠️ ảnh hưởng kiến trúc/nghiệp vụ và **cần xác nhận trước Phase 1**.

| ID | Quyết định | Trạng thái |
|---|---|---|
| D-01 | Modular monolith NestJS, 2 process (api, worker) cùng codebase | Proposed |
| D-02 | pnpm workspaces monorepo: `apps/api`, `apps/web`, `packages/contracts` | Proposed |
| D-03 ⚠️ | LLM sinh **Semantic Query IR**, không sinh SQL; SQL do compiler tất định | Accepted (2026-11-03) |
| D-04 ⚠️ | Dataset lưu thành bảng PostgreSQL có kiểu, schema riêng mỗi tenant, version copy-on-write | Accepted (2026-11-03) |
| D-05 | Prisma cho metadata; `pg` thuần cho data plane | Proposed |
| D-06 ⚠️ | RLS PostgreSQL trên metadata + role riêng mỗi tenant ở data plane | Accepted (2026-11-03) |
| D-07 ⚠️ | Tự xây Semantic Layer (không tích hợp Cube / dbt) | Accepted (2026-11-03) |
| D-08 ⚠️ | LLM provider mặc định: OpenAI (adapter Gemini để sau) | Accepted (2026-11-03) |
| D-09 | Recharts (qua shadcn/ui Chart) thay vì ECharts | Proposed |
| D-10 | Expression DSL hạn chế dùng chung cho quality, cleaning, semantic | Proposed |
| D-11 ⚠️ | Quality score không chặn truy vấn metric; chỉ cảnh báo (org có thể bật chặn) | Accepted (2026-11-03) |
| D-12 | Chỉ lưu mẫu issue (≤500/rule/check), không lưu toàn bộ dòng lỗi | Proposed |
| D-13 | UUID v7 sinh phía app | Proposed |
| D-14 | Auth tự làm (JWT + refresh rotation), không dùng IdP ngoài | Proposed |
| D-15 | UI tiếng Việt mặc định + tiếng Anh, i18n từ Phase 1 | Accepted (2026-11-03) |
| D-16 | Mời thành viên bằng link mời có hạn (copy tay), không gửi email trong MVP | Accepted (2026-11-03) |
| D-17 | Phiên bản nền: NestJS 11 (CJS), TypeScript 5.9, Prisma 7 + `@prisma/adapter-pg`, Vite 7, React 19, React Router 7 | Accepted (Phase 1) |
| D-18 | Config bằng Zod schema tự viết (không dùng `@nestjs/config`); `.env` nạp bằng `process.loadEnvFile` | Accepted (Phase 1) |
| D-19 | Test: Vitest (unit + integration project) với SWC cho decorator metadata; integration chạy trên Postgres/Redis/S3 (SeaweedFS) thật | Accepted (Phase 1) |
| D-20 | Object storage local/CI: SeaweedFS 4.48 (S3 API) thay MinIO – MinIO đã ngừng phát hành image trên Docker Hub; production vẫn là AWS S3 hoặc dịch vụ S3-compatible | Accepted (Phase 1) |
| D-21 | Auth: access JWT HS256 15' (chỉ identity), refresh token opaque trong cookie httpOnly SameSite=Strict, rotation + reuse detection, CSRF header | Accepted (Phase 2a) |
| D-22 | RLS cho cả bảng user-level (`users`, `refresh_tokens`) qua context key; không role nào của ứng dụng có BYPASSRLS | Accepted (Phase 2a) |
| D-23 | Role `insightai_provisioner` riêng cho tạo tenant; org đi qua trạng thái PROVISIONING → ACTIVE, tự retry | Accepted (Phase 2a) |
| D-24 | Quyền tra từ DB mỗi request (không nhúng vào JWT); chưa cache | Accepted (Phase 2a) |
| D-26 | Upload đi qua API (multipart → file tạm → S3, ≤ 100 MB), không dùng presigned URL trong MVP | Accepted (Phase 2c) |
| D-27 | Import: `csv-parse` 7; XLSX bằng reader tự viết (`yauzl` + `sax`, streaming, không phụ thuộc thứ tự part trong zip); `exceljs` chỉ còn là devDependency để tạo file test | Accepted (Phase 2c) |
| D-28 | Suy luận kiểu trong PostgreSQL trên bảng raw; ngưỡng 95%; cột có số 0 đứng đầu giữ là TEXT; XLSX luôn dùng định dạng máy (`en`) | Accepted (Phase 2c) |
| D-29 | Mỗi import tạo version mới và tự thành version đang dùng; ghi đè kiểu bằng re-import với `columnTypes` (không có bước "xác nhận schema" chặn luồng) | Accepted (Phase 2c) |
| D-30 | Profiling chạy nền sau mỗi import; một lần quét cho thống kê cơ bản, lấy mẫu (TABLESAMPLE ~500k dòng) cho distinct/phân vị/top/histogram khi bảng > 1 triệu dòng | Accepted (Phase 2d) |
| D-31 | Biểu đồ hồ sơ dữ liệu bằng CSS thuần (không thêm thư viện); Recharts để dành cho visualization ở Phase 6 | Accepted (Phase 2d) |
| D-32 | Thông báo import (warning/error) dịch ở client theo `code`; server message chỉ là fallback | Accepted (Phase 2d) |
| D-33 | Expression DSL: Pratt parser + kiểm tra kiểu, literal được escape vào SQL (không bind param) để dùng được cả trong `CREATE TABLE AS` của cleaning; NULL = "không xác định", không tính là vi phạm | Accepted (Phase 3a) |
| D-34 | Rule hệ thống tự tạo (đổi kiểu từng cột không phải văn bản + dòng trùng hoàn toàn); chỉ tắt được, không xóa; mỗi version mới được check tự động | Accepted (Phase 3a) |
| D-35 | Gợi ý cleaning bằng AI dời sang Phase 5 (cần lớp LLM); Phase 3 chỉ có gợi ý theo rule | Accepted (Phase 3a) |
| D-36 | Cleaning compile thành một chuỗi CTE, không lọc dòng giữa chừng (`_del` = thao tác đã xóa dòng, `_a<i>` = thao tác đã đổi dòng) → một truy vấn cho preview chính xác trên toàn bảng và một `CREATE TABLE AS` khi áp dụng | Accepted (Phase 3b) |
| D-37 | Version cleaning dùng chung bảng raw của import gốc; tên cột vật lý `c_<n>` và `_row_id` giữ nguyên qua mọi version → rule `type_castable`, giá trị gốc và so sánh version hoạt động trên mọi version | Accepted (Phase 3b) |
| D-38 | Version cleaning không tự kích hoạt; rollback = kích hoạt lại version cũ; lịch sử cleaning bất biến (ứng dụng không xóa/sửa, chỉ ghi số dòng ảnh hưởng) | Accepted (Phase 3b) |
| D-39 | Gợi ý cleaning tính lại khi được hỏi (tất định, không lưu bảng `cleaning_suggestions`); chỉ gợi ý, không bao giờ tự áp dụng | Accepted (Phase 3b) |
| D-40 | Semantic model sửa trên bản nháp; publish kiểm tra lại rồi lưu **snapshot bất biến** (`published_snapshot`, `revision`) – query engine chỉ đọc snapshot | Accepted (Phase 4a) |
| D-41 | Semantic validation: kiểm tra tĩnh (cột, kiểu, biểu thức, đồ thị quan hệ) + kiểm tra dữ liệu (khóa chính, phía "một" của quan hệ unique; orphan chỉ cảnh báo); INVALID thì không publish | Accepted (Phase 4a) |
| D-42 | Query engine: mỗi entity nguồn một CTE aggregate, chỉ join theo hướng many-to-one/one-to-one (BFS ≤ 3 bước, đường ngắn nhất phải duy nhất); nhiều nguồn ghép bằng `UNION ALL` + `GROUP BY` theo dimension; giá trị người dùng luôn là tham số bind | Accepted (Phase 4b) |
| D-43 | SQL sinh ra được kiểm tra bằng parser thật của PostgreSQL (`libpg-query` WASM): 1 câu SELECT, chỉ bảng trong schema tenant của plan, hàm/kiểu trong allowlist, không comment → chặn `SET ROLE`/`set_config` (đóng D-06 ở tầng ứng dụng) | Accepted (Phase 4b) |
| D-44 | Access policy theo system role, có hiệu lực ngay; member ẩn coi như không tồn tại; row filter OR giữa các policy, policy không join an toàn được thì từ chối (fail closed); cache Redis 10 phút theo SQL + tham số + revision + dataset version + policy | Accepted (Phase 4b) |
| D-45 | Metric: định danh ổn định + version bất biến (DRAFT → PUBLISHED → DEPRECATED; partial unique index 1 PUBLISHED, 1 DRAFT; trigger chặn sửa version đã rời DRAFT); filter của metric là filter có cấu trúc (như IR), không phải biểu thức tự do; publish = lập kế hoạch thử trên model đã publish | Accepted (Phase 4c) |
| D-46 | Synonym chuẩn hóa ở ứng dụng (bỏ dấu, đ→d, chữ thường), UNIQUE theo model; catalog lọc theo policy; `compareTo` chỉ cho kết quả không chia theo thời gian | Accepted (Phase 4c) |
| D-25 | Frontend: access token chỉ trong bộ nhớ, khôi phục phiên bằng refresh cookie khi tải trang, refresh single-flight; org đang chọn lưu localStorage (tiện ích, không phải bảo mật) | Accepted (Phase 2b) |

---

### D-01 Modular monolith + worker process
- **Bối cảnh**: MVP, đội nhỏ, yêu cầu cấm microservices; import/quality/cleaning là tác vụ dài.
- **Quyết định**: 1 NestJS codebase, entrypoint `main.ts` (HTTP) và `worker.ts` (BullMQ consumers, không HTTP). Module giao tiếp qua service đã export, không qua HTTP nội bộ.
- **Hệ quả**: deploy 1 image, 2 lệnh chạy. Worker scale độc lập. Ranh giới module được kiểm bằng lint rule (`eslint-plugin-boundaries` hoặc `dependency-cruiser` – chọn ở Phase 1).

### D-02 Monorepo pnpm
- **Lý do**: chia sẻ Zod schema (IR, ChartSpec, DTO) giữa FE/BE/LLM tool schema là giá trị lớn. pnpm workspaces đủ; Turborepo/Nx không cần cho 3 package.

### D-03 LLM → Semantic Query IR (không Text-to-SQL) ⚠️
- **Bối cảnh**: yêu cầu "AI không tự suy diễn KPI", "câu hỏi cùng nghĩa → cùng metric", "không tạo số liệu", "truy vết".
- **Phương án**: (a) LLM viết SQL rồi validate; (b) LLM chọn metric/dimension/filter (IR), compiler sinh SQL.
- **Quyết định**: (b). Pipeline vẫn có bước SQL Generation + AST Validation, nhưng SQL đến từ compiler.
- **Lý do**: (a) cho phép LLM tự viết `SUM(total_amount)` thay vì dùng định nghĩa chuẩn → vi phạm nguyên tắc semantic; khó chống double counting; bề mặt tấn công lớn. (b) tất định, test được, cache được, truy vết rõ.
- **Hệ quả**: câu hỏi ngoài catalog (vd. "khách hàng nào mua 3 lần trong tuần") → `cannot_answer` + gợi ý tạo metric. "Free-form SQL cho analyst" để roadmap, dùng chung AST validator.

### D-04 Dataset = bảng PostgreSQL có kiểu ⚠️
- **Phương án**: JSONB rows · Parquet trên S3 + DuckDB · bảng typed trong Postgres.
- **Quyết định**: bảng typed, `t_<org>.ds_<id>_v<n>`, `_row_id` ổn định, bảng raw TEXT giữ giá trị gốc.
- **Lý do**: một engine SQL cho quality + semantic + AI; phân quyền tầng DB; stack đã có Postgres. DuckDB nhanh hơn cho analytics nhưng thêm engine thứ hai, khó phân quyền đa tenant – xem lại khi có benchmark.
- **Hệ quả**: số bảng tăng theo version; dung lượng ×(N version). Cần retention policy sau MVP.

### D-05 Prisma + pg
- **So sánh**: Prisma – schema DSL rõ, migration tốt, type-safe, phổ biến; hạn chế: query động/DDL kém, RLS cần extension + transaction. TypeORM – gần JPA/Hibernate (quen với dev Spring), decorator entity; hạn chế: type-safety yếu hơn ở query builder, migration autogen kém ổn định, lịch sử bảo trì không đều.
- **Quyết định**: Prisma cho schema `app`. Data plane (bảng động, COPY, DDL, SQL do compiler sinh) dùng `pg` + `pg-copy-streams` – không ORM nào phù hợp cho bảng không biết trước schema, nên đây không phải "dùng hai ORM".
- **Rủi ro**: Prisma + RLS (D-06) → spike Phase 1.

### D-06 RLS + role theo tenant ⚠️
- **Quyết định**: RLS (`FORCE`) trên mọi bảng metadata có `organization_id`; data plane: schema + role reader/writer mỗi tenant, kết nối bằng `SET LOCAL ROLE`.
- **Lý do**: lỗi quên `where organization_id` là lỗi phổ biến nhất của SaaS đa tenant; RLS biến nó thành lỗi "không thấy dữ liệu" thay vì "lộ dữ liệu".
- **Chi phí**: mỗi thao tác tenant nằm trong transaction ngắn; giới hạn số role Postgres (không đáng kể ở quy mô MVP). Fallback nếu spike thất bại: giữ role/tenant ở data plane, metadata dùng app-level scoping bắt buộc + test tự động quét mọi repository.

### D-07 Tự xây Semantic Layer ⚠️
- Xem SEMANTIC_LAYER_DESIGN §2 (bảng điểm: tự xây 38 / Cube 31 / dbt 18).
- Phạm vi giới hạn: Postgres only; simple/ratio/derived; join many-to-one ≤ 3 hop; time comparison; không pre-aggregation.
- Đường lui: IR tương thích khái niệm với Cube query → có thể chuyển engine sau.

### D-08 LLM provider ⚠️
- **Quyết định đề xuất**: OpenAI (SDK `openai`), dùng Structured Outputs (JSON Schema strict) + function calling; model cấu hình qua env. Interface `LlmProvider` để thêm Gemini (`@google/genai`).
- **Lý do**: strict schema adherence giúp IR luôn parse được; SDK TS chính thức ổn định. Gemini cũng đáp ứng (response schema + function calling) và có thể rẻ hơn – chọn theo chi phí/độ trễ thực tế của bạn.
- **Không dùng LangChain**: pipeline là vòng tool-calling ≤ 6 bước với tool do mình định nghĩa; LangChain thêm abstraction mà không thêm năng lực cần thiết.

### D-09 Recharts
- Chart MVP chỉ bar/line/pie/KPI/table với ≤ 1000 điểm; shadcn/ui có `Chart` dựa trên Recharts → cùng theme, dark mode miễn phí. ECharts mạnh hơn cho dữ liệu lớn/biểu đồ phức tạp → xem lại nếu cần (ChartSpec độc lập thư viện nên đổi được).

### D-10 Expression DSL dùng chung
- Không cho người dùng nhập SQL ở rule, filter, measure. Một parser + type-checker + compiler cho cả 3 module → một điểm kiểm soát an toàn, kiểm tra được khi schema đổi.

### D-11 Quality gate ⚠️
- **Đề xuất**: metric vẫn truy vấn được trên dataset có quality FAILED, nhưng câu trả lời/KPI hiển thị cảnh báo + score trong provenance. Org setting `block_on_quality_failed` (mặc định tắt).
- **Câu hỏi cho bạn**: có muốn mặc định **chặn** không? (an toàn hơn về correctness, nhưng người dùng mới dễ bị kẹt).

### D-12 Mẫu issue
- Lưu ≤ 500 dòng lỗi/rule/check; số đếm chính xác luôn đầy đủ; export toàn bộ dòng lỗi bằng job → S3. Tránh bảng issue phình bằng kích thước dữ liệu.

### D-13 UUID v7
- Time-ordered, giảm phân mảnh index so với v4, không lộ số lượng như serial.

### D-14 Auth tự làm
- Argon2id, access JWT 15', refresh opaque 30 ngày, rotation + reuse detection. Đề xuất: không có email verification/SSO trong MVP; cách mời thành viên – xem Open question 6.

### D-06 – Ghi nhận từ spike Phase 1
- **Metadata (RLS)**: `PrismaService.runInTenant(orgId, tx => …)` dùng interactive transaction + `set_config('app.org_id', …, true)`. Đã có integration test: chỉ thấy dòng của tenant, không có context → 0 dòng (fail closed), setting không rò sang connection kế tiếp trong pool, INSERT/UPDATE chéo tenant bị chặn. Chi phí: mỗi thao tác tenant là một transaction (thêm 2 round-trip `BEGIN`/`set_config`); chưa đo benchmark – làm khi có endpoint thật ở Phase 2.
- **Lỗi phát hiện nhờ spike**: sau khi `set_config(..., true)` từng chạy trên một connection, giá trị `app.org_id` trở về `''` (không phải NULL) khi transaction kết thúc; policy dạng `current_setting(...)::uuid` khi đó **ném lỗi** thay vì trả 0 dòng. Mọi RLS policy phải dùng `NULLIF(current_setting('app.org_id', true), '')::uuid` (đã cập nhật DATABASE_DESIGN §4, có test hồi quy).
- **Data plane (role/tenant)**: `DataPlaneService.withTenantRead/Write` → `BEGIN [READ ONLY]; SET LOCAL ROLE t_x_reader|writer; SET LOCAL search_path; SET LOCAL statement_timeout`. Test: không đọc được schema tenant khác hay schema `app`, không ghi được trong phiên đọc, timeout hoạt động.
- **Giới hạn đã biết (quan trọng)**: login role `insightai_analytics` là thành viên của **mọi** role reader. SQL chạy trong phiên có thể tự `SET ROLE` / `SELECT set_config('role', …)` sang reader của tenant khác. Vì vậy role/tenant chỉ chặn SQL *tham chiếu* sai schema; nó **không** thay thế được SQL validator. Hệ quả bắt buộc cho Phase 4–5: AST validator phải từ chối mọi statement không phải `SelectStmt` (gồm `SET`, `RESET`, `DO`, `CALL`) và mọi hàm ngoài allowlist (đặc biệt `set_config`, `current_setting`). Phương án mạnh hơn nếu cần sau MVP: login role riêng mỗi tenant với pool theo tenant (đánh đổi số connection) – ghi trong FUTURE_ROADMAP.

### D-17 Phiên bản nền
- NestJS 12 (10/2026) chuyển sang ESM-only và còn quá mới; hệ sinh thái (`nestjs-pino`, `@nestjs/bullmq`, `@nestjs/terminus`) ổn định trên 11. Chọn 11.2.x, nâng cấp khi 12 ổn định.
- TypeScript 7 (bản native) chưa được typescript-eslint/Nest kiểm chứng với decorator metadata → giữ 5.9.
- Prisma: `latest` trên npm đang trỏ tới 8.0.0-rc → pin 7.10.1 (stable). Prisma 7 bắt buộc driver adapter (`@prisma/adapter-pg`) và `prisma.config.ts`.
- `contracts` build ra ESM; api (CJS) `require` được nhờ Node ≥ 22 hỗ trợ `require(esm)`.

### D-18 Config
- Một `envSchema` Zod, parse khi boot, lỗi chỉ in tên biến (không in giá trị). Bỏ `@nestjs/config` vì chỉ cần một provider `APP_CONFIG` có kiểu.

### D-19 Test
- Vitest thay Jest: nhanh, ESM-native, dùng chung với frontend. SWC plugin để giữ `emitDecoratorMetadata` cho DI của Nest.
- Integration test chạy trên hạ tầng thật (compose local / service containers CI), không mock Postgres – vì RLS, role và DDL là chính thứ cần kiểm chứng.

---

### D-21 Auth
- Access token không nằm trong localStorage (XSS không đọc được refresh token; access token chỉ sống 15 phút trong bộ nhớ). Refresh cookie chỉ gửi tới `/api/v1/auth`, `SameSite=Strict` + header `X-Requested-With` chống CSRF.
- Reuse detection chỉ áp dụng cho token **đã được rotate** (có `replaced_by`); token bị thu hồi do logout thì chỉ đơn giản là hết hạn. Ân hạn 10 giây cho hai tab refresh cùng lúc. (Lỗi phân biệt này được integration test phát hiện.)
- Argon2id qua `@node-rs/argon2` (binary dựng sẵn, không cần toolchain native trên Windows/CI).

### D-22 RLS cho dữ liệu user-level
- Thay vì một role BYPASSRLS cho login/refresh/nhận lời mời, mỗi bước tiền-xác-thực đặt một context key hẹp (`app.login_email`, `app.refresh_token_hash`, `app.invite_token_hash`) làm lộ đúng một dòng. Lợi ích: không có đường đi nào trong ứng dụng đọc được toàn bộ bảng `users`.
- Bài học (đã ghi vào DATABASE_DESIGN §4): `INSERT … RETURNING` bị kiểm tra theo policy SELECT ⇒ bảng chỉ-ghi dùng `createMany`.

### D-23 Provisioning
- PostgreSQL 16: role CREATEROLE chỉ quản trị được role do chính nó tạo ⇒ provisioner không thể chiếm quyền role hệ thống khác. Nó sở hữu schema tenant nhưng không sở hữu và không đọc được bảng dữ liệu.

### D-24 Kiểm tra quyền mỗi request
- Mỗi request tenant tốn 1–2 truy vấn (membership + org). Chấp nhận ở MVP để đổi role/xóa thành viên có hiệu lực tức thì; nếu đo thấy nóng sẽ cache ngắn hạn trên Redis kèm invalidation.

### D-25 Phiên làm việc phía frontend
- `lib/session.ts` giữ access token trong biến module (không localStorage/sessionStorage – có test kiểm tra). Khi tải trang gọi `POST /auth/refresh` để khôi phục phiên; mọi lời gọi refresh dùng chung một promise vì server rotate token.
- `apiFetch` gặp 401 thì refresh một lần rồi gửi lại; refresh thất bại ⇒ kết thúc phiên, guard điều hướng về `/login?redirectTo=…` (chỉ chấp nhận đường dẫn nội bộ, chống open redirect).
- Query key của mọi dữ liệu tenant bắt đầu bằng `['org', organizationId]` ⇒ đổi org không bao giờ hiển thị cache của org khác; đăng nhập/đăng xuất xóa toàn bộ cache.
- Ẩn/hiện nút theo permission chỉ là UX; API luôn tự kiểm tra.
- Bài học (Phase 2b): không kiểm tra time zone bằng `Intl.supportedValuesOf('timeZone')` – ICU trả `Asia/Saigon` chứ không có `Asia/Ho_Chi_Minh` (mặc định của chúng ta). Dùng `isValidTimeZone` (thử tạo `Intl.DateTimeFormat`) trong `packages/contracts`.

### D-26 Upload qua API
- Server kiểm tra nội dung (magic bytes / ký tự NUL) trước khi lưu – phần mở rộng do người dùng đặt nên không đáng tin. File ghi ra file tạm (không giữ trong RAM), băm SHA-256 trong cùng lượt stream lên S3, xóa file tạm ngay sau đó.
- Presigned upload trực tiếp lên S3 (giảm tải API cho file rất lớn) → roadmap.

### D-27 Đọc XLSX
- Ban đầu dùng streaming reader của `exceljs` 4.4 (bản cuối 2023). Integration test lặp lại phát hiện lỗi **không ổn định**: reader đọc zip tuần tự nên phụ thuộc thứ tự part do phần mềm tạo file ghi ra – nếu sheet đứng trước `xl/workbook.xml` thì crash (`this.model.sheets`), nếu đứng trước `styles.xml` thì **ngày bị đọc thành số mà không báo lỗi**.
- Thay bằng `parsing/xlsx-reader.ts` (~300 dòng): `yauzl` đọc central directory (truy cập part theo tên, đúng thứ tự cần), `sax` stream XML. Đọc workbook + rels (thứ tự sheet người dùng thấy, `date1904`), styles (style nào là ngày: format dựng sẵn 14–22, 45–47 và format tùy chỉnh chứa d/m/y/h/s), shared strings, rồi stream đúng một sheet. Có unit test cho cột, định dạng ngày, serial → ngày.
- Zip-bomb guard (`assertSafeZip`): từ chối file giải nén > 1 GiB hoặc > 10.000 entry trước khi parse. Shared strings giữ trong RAM (bị chặn bởi guard trên).
- `exceljs` chuyển sang devDependency (chỉ để tạo file XLSX trong test) ⇒ không còn trong `pnpm audit --prod`. `multer`, `js-yaml` được nâng qua `overrides` trong `pnpm-workspace.yaml`; `csv-parse` lên 7.0.3.

### D-28 Suy luận kiểu
- Một truy vấn aggregate đếm số giá trị khớp từng mẫu cho mọi cột (không đọc dữ liệu vào Node). Ưu tiên hẹp nhất: BOOLEAN → INTEGER → DECIMAL → DATE → TIMESTAMP → TEXT.
- Mẫu số loại trừ giá trị bắt đầu bằng `0` theo sau là chữ số (số điện thoại, mã `00123`) ⇒ cột như vậy là TEXT – tránh mất số 0 đầu.
- `vi`: `1.234.567,89`, `dd/MM/yyyy`; `en`: `1,234,567.89`, `MM/dd/yyyy`. Ô số/ngày của Excel là giá trị máy nên XLSX luôn dùng `en`/ISO bất kể locale.
- Hiệu năng đo được (máy dev, Docker Desktop): 500.000 dòng × 8 cột (30 MB CSV) import trong 24 giây (~21k dòng/giây).

### D-29 Version khi import
- Người dùng chủ động tải dữ liệu mới nên import thành công trở thành version đang dùng. Import thất bại không ảnh hưởng version hiện tại. Version cleaning (Phase 3) mới cần bước kích hoạt thủ công.

### D-30 Profiling
- `ProfilerService` (worker, hàng đợi `profiling`) chạy qua role reader của tenant trong transaction READ ONLY. Kết quả lưu `column_profiles.stats` (JSON theo `columnProfileSchema` trong contracts); số là chuỗi thập phân chính xác (`trim_scale(round(x, 6))`), không đi qua float.
- Thống kê: số ô trống, số giá trị khác nhau, min/max, mean/stddev/tứ phân vị và histogram 20 khoảng (số), độ dài (văn bản), phân bố theo tháng – tự đổi sang theo năm nếu > 120 tháng (ngày), top 10 giá trị.
- Đo trên máy dev: 500k dòng × 8 cột: 2,1 giây; 1,2 triệu dòng (lấy mẫu): 3,2 giây. Profiling lỗi không ảnh hưởng import; người có `dataset:write` bấm "Tính lại".
- Tứ phân vị/distinct trên mẫu được đánh dấu `approximate` và hiển thị rõ trên UI.

### D-32 Thông báo đa ngôn ngữ
- Import worker không biết ngôn ngữ người xem, nên trả `code` ổn định (`TOO_MANY_ROWS`, `INVALID_VALUES`, …). Frontend dịch theo code, dùng message của server khi gặp code mới. Phát hiện khi chạy E2E: thông báo tiếng Anh xuất hiện trên giao diện tiếng Việt.

### D-33 Expression DSL
- `modules/expression/expression.ts`: tokenizer → Pratt parser → type-check theo kiểu cột → SQL. Chỉ cho phép: so sánh, AND/OR/NOT, IN, BETWEEN, LIKE, IS NULL, + − × ÷, CASE, và hàm `coalesce, nullif, lower, upper, trim, length, abs, round, date_trunc`. Giới hạn 2.000 ký tự, độ lồng 40.
- Tên cột chỉ được ánh xạ qua scope từ metadata (`t."c_n"`); token trong biểu thức không bao giờ trở thành identifier SQL. Literal: chuỗi escape kiểu `escapeLiteral` (E'' khi có \\), số và ngày kiểm tra bằng regex. Có test cho các ca tấn công (dấu nháy, `--`, `;`, `pg_sleep`, `set_config`, `schema.table`).
- Chia cho 0 cho NULL (`NULLIF`) thay vì làm hỏng cả lần check.
- Rule consistency: dòng vi phạm khi `NOT coalesce(expr, true)` – giá trị thiếu là việc của rule completeness.

### D-34 Chạy quality check
- Rule kiểm tra từng dòng được gộp vào **một** truy vấn (`count(*) FILTER`); nếu truy vấn gộp lỗi (vd. regex quá chậm chạm timeout) thì chạy lại từng rule trong SAVEPOINT riêng để chỉ rule hỏng bị báo ERROR. `unique`, `duplicate_rows`, `foreign_key` chạy truy vấn riêng.
- Mỗi rule lưu tối đa 100 dòng lỗi mẫu kèm giá trị gốc từ bảng raw. Kết quả lưu snapshot của rule (báo cáo cũ vẫn đúng khi rule bị sửa/xóa); ứng dụng không được xóa/sửa lịch sử check.
- Một check đang chờ/chạy cho mỗi version (partial unique index). Rule hệ thống: severity warning; regex được PostgreSQL kiểm tra cú pháp khi lưu.
- Đo trên máy dev: check tự động 500k dòng (5 rule hệ thống) xong song song với profiling (< 3 giây).

### D-36 Biên dịch cleaning
- `modules/cleaning/cleaning-compiler.ts` (thuần, có unit test): `s0` đọc version nguồn (và bảng raw khi cần), mỗi thao tác thêm 1–2 CTE. Thao tác đổi giá trị tính giá trị mới vào cột tạm rồi thay vào ở CTE sau, cờ `_a<i>` so sánh cũ/mới. Thao tác xóa dòng chỉ ghi `_del = i`; bảng mới = `WHERE _del IS NULL`.
- Vì không lọc giữa chừng nên mỗi thao tác được đếm trên toàn bảng trong **một** lần quét (preview chính xác, không ước lượng), và job ghi lại `affected_rows`/`removed_rows` cho từng thao tác.
- Mọi giá trị người dùng đi qua `sqlString` hoặc regex chặt; identifier chỉ lấy từ metadata và được kiểm tra lại (`c_<n>`, tên bảng `v_`/`r_`). `drop_rows` dùng lại Expression DSL và trình biên dịch rule của 3a.
- `median` chính xác: trung bình của `percentile_disc(0.5)` tăng và giảm dần (không qua `float8`). `fill_null previous`: nhóm theo số giá trị đã có trước đó (`count … OVER (ORDER BY _row_id)`).
- `cast_column` đọc lại giá trị gốc trong file (giá trị do thao tác trước điền vào thì đọc dạng chuẩn); `parse_date` giữ ngày đã hợp lệ và chỉ thử lại giá trị trống/sai.
- Đo trên máy dev (500k dòng, 5 thao tác): gợi ý 0,5 giây, preview 3,1 giây, áp dụng 4,8 giây.

### D-37 Bảng raw dùng chung
- Version cleaning trỏ `raw_table` về bảng raw của import gốc. Cột không bao giờ được thêm, chỉ đổi tên/kiểu/xóa, nên `c_<n>` luôn ứng với cùng cột trong raw; dòng bị xóa chỉ biến mất khỏi bảng typed.
- `dataset_columns` của version mới: `nonEmptyCount` = có giá trị hoặc có giá trị gốc; `invalidCount` = có giá trị gốc nhưng vẫn không hợp lệ với kiểu cột.
- Đổi tên cột: rule tham chiếu tên cũ bị SKIPPED trên version mới (rule hệ thống cho tên mới được tạo tự động).

### D-38 Kích hoạt và lịch sử
- Import mới tự kích hoạt (D-29), cleaning thì không: người dùng xem so sánh (dòng, cột, điểm, từng rule) rồi mới kích hoạt. Mọi version được giữ lại.
- `cleaning_jobs`/`cleaning_operations`: RLS theo org, thu hồi DELETE; `cleaning_operations` chỉ cho UPDATE hai cột số liệu. Audit: `cleaning.requested`, `dataset.version_created`, `dataset.version_activated`.

### D-39 Gợi ý theo rule
- Nguồn: kết quả FAILED của check thành công gần nhất + vài truy vấn tổng hợp. Khoảng trắng thừa → `trim_whitespace`; cùng giá trị khác hoa/thường/khoảng trắng (chỉ cột văn bản ≤ 5.000 giá trị khác nhau theo profile) → `replace_values` về dạng phổ biến nhất; ngày sai có định dạng khác → `parse_date`; thiếu số (≤ 20%) → `fill_null median`; dòng/khóa trùng → `deduplicate`; dòng vi phạm rule mức *error* → `drop_rows { ruleId }`.
- Chưa làm (roadmap): biến thể theo dấu tiếng Việt/Levenshtein; lưu trạng thái chấp nhận/bỏ qua gợi ý.

### D-40 Bản nháp và snapshot
- Entity/dimension/measure/relationship sửa trực tiếp; mỗi thay đổi đánh dấu `has_draft_changes` và xóa kết quả kiểm tra. Truy vấn không bị ảnh hưởng vì engine (4b) đọc `published_snapshot`.
- Publish khóa dòng model, so `updated_at` với lúc bắt đầu kiểm tra (có thay đổi xen giữa → 409, publish lại) rồi tăng `revision`.
- Bảng tách riêng (`semantic_entities`, `semantic_dimensions`, `semantic_measures`, `semantic_relationships`) để có ràng buộc key/FK/RLS ở DB; xóa entity xóa dây chuyền các thành phần của nó.
- `access_policies`, `synonyms` và metric/version để lại cho 4b/4c.

### D-41 Semantic validation
- `modules/semantic/semantic-validation.ts` (thuần, có unit test): dataset còn dùng được, cột khóa/cột join tồn tại, kiểu join tương thích, biểu thức DSL hợp lệ, time dimension có kiểu ngày, `sum/avg` cần số; nhiều quan hệ giữa hai entity cần đúng một `preferred`; chu trình trong đồ thị quan hệ → cảnh báo nhiều đường join.
- Kiểm tra dữ liệu (data plane, chỉ đọc, timeout 60 giây, mỗi kiểm tra một SAVEPOINT): khóa chính không trống và không trùng; cột join phía "một" (và phía "từ" của ONE_TO_ONE) không trùng khi không phải khóa chính; orphan chỉ cảnh báo.
- Dataset có quality FAILED → cảnh báo (D-11).

### D-42 Query engine
- `modules/query-engine/query-planner.ts` (thuần, có unit test): resolve member trên snapshot đã publish (D-40) và cột của active version; mỗi measure tính ở grain entity của nó.
- Join: chỉ đi từ phía "nhiều" sang phía "một" (và chiều ngược của one-to-one) nên không nhân bản dòng nguồn. Dimension chỉ tới được qua bước one-to-many → `FANOUT_JOIN`; quan hệ song song dùng cái `preferred`.
- Nhiều nguồn (vd. doanh thu của order + số lượng của order_item theo trạng thái đơn): mỗi nguồn một CTE, ghép bằng `UNION ALL` rồi `GROUP BY` (NULL được coi là bằng nhau, khác `FULL JOIN … USING`).
- Thời gian: `date_trunc(granularity)::date`; khoảng ngày `[from, to + 1 ngày)` theo múi giờ tổ chức. Lấy `limit + 1` dòng để biết bị cắt. Giá trị trả về dạng text của PostgreSQL.
- Chưa làm: lọc theo measure (HAVING), `compareTo` (đưa vào 4c cùng metric), fan-out có dedup (roadmap).

### D-43 SQL validator
- Parser thật của PostgreSQL (`libpg-query` 18.1.5, WASM, không cần build native) thay vì kiểm tra chuỗi: bắt được `WITH x AS (DELETE …)`, hàm bị cấm ở mọi độ sâu, bảng ngoài schema tenant.
- Lỗi validator là lỗi của compiler (không phải input người dùng): ghi log, trả `SQL_REJECTED`.
- Vẫn giữ phòng thủ tầng DB: `READ ONLY`, role reader của tenant, `statement_timeout` 15 giây.

### D-44 Access policy & cache
- Policy gắn system role (owner/admin/analyst/viewer); thuộc tính người dùng (vd. vùng của từng thành viên) chưa có – roadmap.
- Lịch sử mọi truy vấn (`query_history`: IR, SQL, dataset versions, policy, trạng thái, mã lỗi, số dòng, cache, thời gian); ứng dụng không sửa/xóa được.
- Cache là tối ưu hóa: Redis lỗi thì vẫn chạy truy vấn bình thường.

### D-45 Metric
- Planner mở rộng metric thành các "lá" (measure + filter của metric). Lá cùng entity và cùng filter dùng chung một CTE (vd. `paid_revenue` và `paid_orders`); lá khác filter có CTE riêng rồi ghép như D-42, nên filter của metric này không ảnh hưởng metric khác.
- RATIO = `trim_scale(tử / NULLIF(mẫu, 0))`; DERIVED = Expression DSL trên key metric, tính ở SELECT ngoài cùng. Vòng phụ thuộc bị phát hiện khi publish (và khi truy vấn): `METRIC_CYCLE`.
- Thành phần bên trong metric (measure, dimension của filter, time dimension mặc định) không bị kiểm tra member access: quyền gắn với metric (`metric:<key>`); row filter vẫn luôn áp dụng.
- Publish chạy chính planner với định nghĩa nháp (không áp policy) → metric đã publish luôn chạy được tại thời điểm publish. Phần phụ thuộc phải đã publish. `query_history.metric_version_ids` lưu version đã dùng.
- Không có bảng `metric_dependencies`: phụ thuộc đọc từ định nghĩa khi cần (số metric nhỏ); bảng để roadmap khi cần tra ngược.

### D-46 Synonym, catalog, compareTo
- Chuẩn hóa cụm từ bằng code (không cần extension `unaccent`/`pg_trgm`); tìm kiếm mờ cho AI để Phase 5.
- Catalog: chỉ metric ACTIVE có bản publish và dimension không ẩn, lọc theo access policy của người gọi.
- `compareTo`: kỳ trước = cùng số ngày ngay trước; cùng kỳ năm trước = lùi 1 năm (29/2 → 28/2). Mỗi kỳ là một bộ CTE riêng, ghép cùng chỗ. Chưa hỗ trợ khi chia theo thời gian (ghép bucket lệch kỳ) – roadmap.

### D-47 AI pipeline (Phase 5a)
- Adapter OpenAI gọi Chat Completions qua `fetch` (không thêm SDK); pipeline chỉ phụ thuộc interface `LlmProvider`, test dùng provider kịch bản. Không cấu hình `OPENAI_API_KEY` + `OPENAI_MODEL` → `/ai/ask` trả 503 `AI_UNAVAILABLE`, phần còn lại của sản phẩm chạy bình thường.
- LLM chỉ gọi tool (tối đa 6 bước); tham số tool được kiểm tra bằng schema strict (trường lạ như `sql` → "Invalid arguments", trả lại cho model). Query bị từ chối được trả lại cho model để tự sửa. Catalog đưa cho model đã lọc theo policy của người hỏi.
- Con số: model chỉ viết narrative với placeholder `{{cell:<row>.<key>}}`, `{{stat:<name>}}`; server điền giá trị đã format. Narrative có chữ số ngoài placeholder, placeholder lạ hoặc lỗi gọi model → narrative tất định (fallback). Chart chọn bằng luật theo hình dạng kết quả.
- Quota: số câu hỏi (message USER) mỗi org trong ngày UTC (`AI_DAILY_QUESTION_LIMIT`, mặc định 200) → 429 `RATE_LIMITED`. Mỗi lần gọi model ghi `llm_usage` (không sửa/xóa).
- Hội thoại riêng tư theo người tạo (404 với người khác, kể cả owner). Follow-up: gửi 3 lượt gần nhất + IR của câu trả lời gần nhất làm ngữ cảnh.

### D-48 Ask UI & eval (Phase 5b)
- Web đọc SSE bằng `fetch` + `ReadableStream` (EventSource không gửi được body và bearer token); lỗi trước khi stream là RFC 7807 như mọi API khác.
- Biểu đồ vẽ bằng SVG thuần (không thêm thư viện chart); loại biểu đồ vẫn do server chọn. "Xem SQL" gọi `/semantic-query/compile` nên chỉ hiện với quyền `semantic:write`.
- Eval set `apps/api/test/eval/ai-eval-set.json`: câu trả lời đúng khi các dòng kết quả bằng với chạy trực tiếp `expect.query` qua semantic layer (không so IR từng trường, vì nhiều IR cho cùng kết quả); câu không trả lời/được hỏi lại chấm theo status. Chạy thật: `AI_EVAL=true` (cần key, ngưỡng `AI_EVAL_MIN` mặc định 0.8); `AI_EVAL=oracle` kiểm tra chính bộ eval mà không cần key.

### D-49 Dashboards (Phase 6A)
- PRIVATE/ORG được thực thi bằng RLS: policy `dashboards_visible` cần cả `app.org_id` và `app.user_id` (PRIVATE chỉ tồn tại với chủ sở hữu, người khác nhận 404 như dữ liệu tenant khác); INSERT chỉ với `owner_id = app.user_id`; widget hiển thị khi dashboard của nó hiển thị (subquery cũng chịu RLS).
- Quyền sửa: chủ dashboard; dashboard ORG thêm owner/admin của tổ chức. Chỉ chủ dashboard đổi PRIVATE ↔ ORG. Viewer chỉ đọc (theo quyền `dashboard:write` sẵn có).
- Widget lưu IR + chart spec + vị trí lưới 12 cột, không lưu SQL/kết quả. Khi lưu: compile với quyền người lưu (422 nếu không chạy được). Khi xem: chạy với quyền và policy của người xem, luôn dùng version metric đang publish; `saved_model_revision`/`saved_metric_versions` chỉ để cảnh báo thay đổi.
- Ghim câu trả lời AI: chỉ từ message `ANSWERED` trong hội thoại của chính người gọi (404/409); không sao chép narrative hay kết quả.
- UI (6A): lưới 12 cột bằng CSS grid, di chuyển/đổi cỡ bằng nút (không thêm thư viện kéo thả), chặn chồng lấn phía client; màn hình nhỏ xếp một cột theo thứ tự y, x. Widget báo "định nghĩa đã đổi" khi version metric hiện hành khác `savedMetricVersions`, "cần cập nhật" khi 422, "không khả dụng" khi metric/member bị ẩn hoặc xóa.
- Giới hạn 200 dashboard mỗi người (đếm theo dashboard nhìn thấy được) và 30 widget mỗi dashboard. Audit: `dashboard.created`, `dashboard.visibility_changed`, `dashboard.deleted`.

### D-50 Production readiness & AI data sharing (Phase 6B)
- `organizations.ai_data_sharing` `METADATA_ONLY` (mặc định) | `FULL`, đổi bởi `org:update`, có audit. METADATA_ONLY: LLM chỉ nhận catalog + câu hỏi; không có tool `get_dimension_values`, không gọi bước diễn giải (narrative tất định), lịch sử hội thoại gửi "đã hiểu là…" thay vì câu trả lời có số. Giá trị filter do model viết được khớp phía server với giá trị lưu trữ (không dấu, không hoa thường; 50 giá trị phổ biến + tìm theo từ) cho **cả hai** chế độ.
- Văn bản tự do của model (câu hỏi lại, lý do không trả lời, lựa chọn) chỉ hiển thị khi không có chữ số (`\p{Nd}`) và link; lựa chọn có chữ số chỉ giữ khi trùng nhãn/synonym catalog. Số viết bằng chữ chưa chặn (rủi ro chấp nhận).
- Quota câu hỏi: đếm và ghi message USER trong cùng transaction với `pg_advisory_xact_lock` theo org.
- SSE: heartbeat comment `: ping`, deadline tổng `AI_ANSWER_TIMEOUT_MS` (90 s) ⇒ sự kiện `AI_TIMEOUT`; phát hiện client rời đi bằng `res.on('close')` (sửa lỗi 5a: `req` 'close' bắn ngay khi đọc xong body nên hủy lời gọi OpenAI thật).
- Production: image API/worker (Node 24 bookworm-slim, non-root), job `migrate` (roles + migrations), web = Caddy (HTTPS tự động, SSE không buffer), Redis bắt buộc mật khẩu (kiểm tra trong `env.schema`), backup = roles không mật khẩu + `pg_dump -Fc`, mã hóa AES-256/PBKDF2 ([OPERATIONS.md](OPERATIONS.md)).

### D-51 Analytical engines (Phase 6D)
- Engine tất định thuần TypeScript trên `SemanticQueryResult` (`modules/investigation/analysis/*`), không SQL mới: mọi số liệu đến từ query engine chạy **với quyền người dùng** (`source = INVESTIGATION`).
- Cộng/trừ số liệu kinh doanh bằng thập phân chính xác (`decimal.ts`, BigInt theo scale); tỷ lệ, slope, z-score dùng float64 và làm tròn 6 chữ số khi lưu.
- Contribution chỉ cho metric additive (SIMPLE trên `sum`/`count`; catalog có `additive`); tổng do các member cộng lại, so với tổng truy vấn riêng ⇒ `TOTAL_MISMATCH` nếu lệch. Metric khác ⇒ 422 `NOT_ADDITIVE`. RATIO có hai thành phần additive ⇒ phân rã mix/rate đối xứng (rate = Δr·w̄, mix = Δw·r̄); member có tử số mà không có mẫu số ⇒ `residual` + `TOTAL_MISMATCH`.
- Trend: hồi quy bình phương tối thiểu theo vị trí lịch (khoảng trống giữ chỗ, không điền), bỏ kỳ hiện tại chưa trọn khỏi đường hồi quy, cần ≥ 4 điểm, "flat" khi đường đi < 2 % trung bình. Anomaly: median/MAD, |z| ≥ 3,5, cần ≥ 14 điểm, chuỗi hằng không có bất thường. Distribution: tỷ trọng, số member đạt 80 %, HHI, Gini (bỏ qua khi có giá trị âm).
- Mỗi kết quả kèm `limitations` (TRUNCATED, POLICY_FILTERED, NULL_VALUES, ZERO_BASELINE, GAPS, PARTIAL_PERIOD, LOW_SAMPLE…) để báo cáo 6F hiển thị.

### D-52 Investigation core (Phase 6C)
- Analysis Plan IR (`packages/contracts/src/investigation.ts`): schema strict, 6 tool, ≤ 12 bước, ≤ 5 giả thuyết, không SQL/biểu thức/số. Planner (LLM) chỉ nhận mục tiêu + catalog đã lọc policy (kể cả `additive`/`ratio`), không bao giờ nhận dữ liệu; trả `propose_plan` hoặc `cannot_plan`. Kế hoạch lỗi được trả lại với mã (PLAN_ERROR_CODES), tối đa 2 lần sửa; mỗi bước phải compile được với quyền người tạo.
- Máy trạng thái lưu ở PostgreSQL (`investigations`, `investigation_steps`, `investigation_events` append-only), chạy trong worker BullMQ (`investigation`, job id theo pha `plan`/`run`). Bước đã xong không chạy lại khi job retry; bước dở được chạy lại (≤ 3 lần). Hủy: dừng ngay nếu chưa chạy, nếu đang chạy thì trước bước kế tiếp.
- Trước mỗi bước: dựng lại `TenantContext` từ membership (mất quyền ⇒ FAILED `FORBIDDEN`), so revision model và version metric đã chốt (khác ⇒ FAILED `MODEL_CHANGED`, không trộn version), kiểm ngân sách (thời gian/số query ⇒ PARTIAL `BUDGET_EXCEEDED`). Query bị từ chối ⇒ bước FAILED, các bước khác vẫn chạy ⇒ PARTIAL.
- Thành viên "phạm vi" (`top_contributors`, `top_decliners`, `anomalous_members`) được server lấy từ kết quả tất định của bước trước, không do LLM.
- Mặc định chọn trong khi chờ PO (PHASE6_AI_ANALYST_DESIGN §5.10): dùng quyền `semantic:query`; duyệt kế hoạch là tùy chọn (`requireApproval`, mặc định tắt); riêng tư theo người tạo (RLS org + user, kể cả owner tổ chức không xem được); ngân sách 12 bước / 30 query / 60k token / 5 phút; giới hạn **theo người dùng** (RLS riêng tư không đếm được toàn tổ chức) `INVESTIGATION_DAILY_LIMIT` = 20/ngày, `INVESTIGATION_MAX_ACTIVE` = 2. Evidence/giả thuyết (6E) và báo cáo (6F) chưa có: kết thúc ở COMPLETED/PARTIAL với output từng bước.
- SSE `GET /investigations/:id/events`: replay từ DB theo `Last-Event-ID` rồi nghe Redis pub/sub, heartbeat, đóng sau `done` hoặc 10 phút. Provider LLM tách thành `LlmModule` dùng chung cho Hỏi đáp và investigation.

### D-53 Evidence, hypotheses, findings (Phase 6E)
- Mỗi bước thành công tạo đúng một **evidence** trong cùng transaction đánh dấu bước xong: IR đã chạy, `query_history_ids`, version model/metric/dataset (+ điểm chất lượng), policy đã áp dụng, kết quả (≤ 1000 dòng/query), giá trị có tên cho placeholder (`total.delta`, `top.0.member`…, số thập phân chính xác) và hạn chế. Bảng chỉ INSERT với role ứng dụng; xem lại không bao giờ chạy lại hay đổi sang version mới.
- Sau các bước: trạng thái `VALIDATING`, kiểm chứng giả thuyết bằng luật tất định (ngưỡng mặc định: member ≥ 40 % thay đổi, thay đổi tổng ≥ 1 %, metric đổi ≥ 2 %, R² ≥ 0,5; chuỗi đi ngang là bằng chứng chống xu hướng). Kết quả `SUPPORTED | NOT_SUPPORTED | INCONCLUSIVE | UNTESTED` kèm mã lý do, ngưỡng và giá trị quan sát; không bao giờ kết luận nhân quả. Member vắng mặt khi có row policy/kết quả bị cắt ⇒ INCONCLUSIVE (không phải NOT_SUPPORTED).
- Finding suy ra tất định từ output (thay đổi metric, member dẫn dắt, mix/rate, xu hướng, độ tập trung, bất thường), mỗi finding gắn evidence, `importance` 0…1 tính toán (giảm một nửa khi evidence có TRUNCATED/TOTAL_MISMATCH), `verified = false` khi không có dữ liệu. PARTIAL vẫn được kiểm chứng trên phần đã chạy; resume trong VALIDATING làm lại (idempotent).
- (Sửa 2026-11-07) Xu hướng có độ khớp yếu (R² < 0,5, cùng ngưỡng với luật `trend_direction`) không được gọi là tăng/giảm: finding `trend.unclear` ("biến động, không có xu hướng rõ"), importance 0,1.

### D-54 Investigation report (Phase 6F-1)
- Sau `VALIDATING` thêm pha `REPORTING` (resume được, ghi đè idempotent): báo cáo lưu trong `investigation_reports.content` (JSON đã render, RLS theo investigation như evidence). Chỉ COMPLETED/PARTIAL có báo cáo; CANCELLED/FAILED thì `GET /report` → 409.
- Văn bản là **segment**: mọi số liệu là segment `value` gắn `evidenceId` + tên giá trị ⇒ truy được tới evidence. Câu tất định theo `templateKey` của finding (vi/en), định dạng theo cột metric trong evidence (đơn vị, %, dấu ±). Biểu đồ = `chartFor(results[0])` của evidence, vẽ từ kết quả đã đóng băng.
- LLM (tool `write_report`) chỉ viết lời với placeholder `{{ev:eN.<tên>}}`, `{{finding:fN.<tham số>}}` (alias ngắn thay UUID). Guard từng đoạn: chữ số mọi hệ chữ (`\p{Nd}`), URL, ngoặc nhọn lạ, placeholder lạ, quá dài ⇒ đoạn đó dùng template; finding chưa kiểm chứng luôn dùng template. Khuyến nghị (≤ 3) phải gắn ≥ 1 finding hợp lệ, không có bản tất định.
- `METADATA_ONLY`: LLM chỉ nhận mục tiêu, giả thuyết, tên tham số/giá trị (không giá trị, không member); `FULL`: thêm giá trị đã định dạng. Lỗi LLM, thiếu token (< 2000 còn lại) hoặc PARTIAL do `BUDGET_EXCEEDED` ⇒ báo cáo tất định hoàn toàn (`renderer: deterministic`), không làm run thất bại.
- Hạn chế tự sinh: run PARTIAL, bước FAILED/SKIPPED, mã hạn chế của evidence (kèm evidenceIds), điểm chất lượng từng dataset/version.
- Ghim finding: `POST /dashboards/:id/widgets { fromEvidenceId }` lấy IR đầu tiên của evidence (chỉ evidence của chính người gọi – RLS) và chart theo kết quả; widget sau đó chạy live với quyền người xem như mọi widget (D-49).

### D-55 AI evaluation (Phase 6G)
- Two sets: Q&A (60, `ai-eval-set.json`) and investigations (210, groups B–K, `test/eval/investigation-eval-set.ts` – TypeScript tables instead of the JSON file named in the design, to keep 210 cases short). Synthetic fixture with planted effects; ground truth computed from the raw rows, not through the semantic layer.
- `AI_EVAL=oracle` scripts the model (ideal or deliberately bad output) and runs in CI: it gates the deterministic pipeline, guards and isolation. Engine misses against planted truth are listed in `KNOWN_ORACLE_FAILURES`; the run must fail exactly those, so a fix or a new miss both break CI.
- `AI_EVAL=true` uses the real model, skips cases that script bad output, reports per group against the design thresholds without failing; results go to `docs/EVAL_REPORT.md` (no customer data).

### D-56 End-to-end tests (Phase 6H-1)
- Playwright 1.64.1 (root dev dependency, Chromium only), one spec for the whole journey through the UI in English; runs the built API + worker, the Vite dev server (own ports 3200/5180, queue prefix `insightai-e2e`) and a fake OpenAI endpoint (`e2e/fake-openai.mjs`, via `OPENAI_BASE_URL`) – no real key, deterministic replies.
- Accounts use the integration-test e-mail domain, so `pnpm test:int` cleans them locally; CI starts from an empty database. No separate `docker/compose.e2e.yml`: CI reuses the integration job's service containers.
- CI job `e2e` uploads the Playwright report and traces on failure.

---

## Open questions (cần bạn trả lời trước Phase 1)

1. ~~**D-03, D-04, D-06, D-07**: đồng ý các quyết định kiến trúc lõi?~~ → **Accepted 2026-11-03.**
2. ~~**D-08**: OpenAI hay Gemini?~~ → **OpenAI**.
3. ~~**D-11**: quality FAILED – cảnh báo hay chặn?~~ → **Cảnh báo** (org có thể bật chặn).
4. **Giới hạn dữ liệu** (A1): 100 MB/file, 2 triệu dòng, 300 cột – có phù hợp khách hàng mục tiêu? *(Đã hiện thực theo các giá trị này ở 2c; đổi được qua `IMPORT_MAX_*` và `IMPORT_LIMITS`.)*
5. ~~**Ngôn ngữ giao diện**~~ → **VI mặc định + EN** (D-15).
6. ~~**Mời thành viên**~~ → **Link mời copy tay** (D-16). Cần thêm bảng `invitations` (token hash, role, expires_at, accepted_at) ở Phase 2.
7. **Referential integrity**: chỉ giữa các dataset trong cùng org (đề xuất) – đúng nhu cầu?
8. **Hạ tầng triển khai đích** (VPS tự quản, AWS, GCP…)? Ảnh hưởng S3/Redis/Postgres managed và CI/CD Phase 6, không ảnh hưởng Phase 1.
