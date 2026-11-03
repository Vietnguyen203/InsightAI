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
