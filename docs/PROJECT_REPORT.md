# InsightAI – Báo cáo dự án

Ngày lập: 11/11/2026 · Trạng thái: **MVP hoàn tất, đang chuẩn bị pilot** · Nhánh chính: `main` (commit `b6e08b6`)

## 1. Tóm tắt

InsightAI là phần mềm phân tích dữ liệu kinh doanh (BI) có AI, dùng cho nhiều doanh nghiệp trên cùng một hệ thống
(multi-tenant). Người dùng tải dữ liệu lên, hệ thống kiểm tra và làm sạch, người phụ trách định nghĩa chỉ số (doanh
thu, số đơn…) một lần, sau đó ai cũng có thể **hỏi bằng tiếng Việt** và nhận số liệu, biểu đồ, hoặc nhờ AI **điều tra
nguyên nhân** một biến động.

Điểm khác biệt chính: **AI không tự viết SQL và không tự nghĩ ra con số**. AI chỉ chọn chỉ số, chiều phân tích và
khoảng thời gian từ danh mục đã được duyệt; truy vấn do hệ thống sinh và kiểm tra; mọi con số người dùng đọc đều lấy
từ kết quả truy vấn, có nguồn và bằng chứng đi kèm.

Toàn bộ 6 giai đoạn phát triển (Phase 0–6) đã xong. Còn lại là các điều kiện bắt đầu pilot (mục 8): chấm AI với
model thật (đang chạy mỗi ngày), triển khai lên mạng và thỏa thuận dữ liệu với khách pilot.

## 2. Mục tiêu và phạm vi MVP

- Người dùng: doanh nghiệp vừa và nhỏ tại Việt Nam; giao diện tiếng Việt (mặc định) và tiếng Anh.
- Thứ tự ưu tiên khi thiết kế: số liệu đúng > chất lượng dữ liệu > chỉ số nhất quán > bảo mật > độ chính xác của AI >
  trải nghiệm > khả năng mở rộng.
- Ngoài phạm vi MVP (ghi trong `docs/FUTURE_ROADMAP.md`): kết nối trực tiếp database/Google Sheets và đồng bộ tự
  động, mời và báo cáo qua email, đăng nhập SSO, thanh toán theo gói.

## 3. Tính năng đã có

| Nhóm | Người dùng làm được gì |
|---|---|
| Tài khoản & tổ chức | Đăng ký, đăng nhập, nhiều tổ chức cho một người, mời thành viên bằng link, 4 vai trò (chủ sở hữu, quản trị, phân tích, chỉ xem), nhật ký hoạt động |
| Dữ liệu | Tải CSV/Excel (đến 100 MB, 2 triệu dòng, 300 cột), tự nhận kiểu cột, xử lý nền có tiến trình, mỗi lần tải là một phiên bản, xem dữ liệu và hồ sơ từng cột |
| Chất lượng dữ liệu | Quy tắc kiểm tra (trống, trùng, khoảng giá trị, biểu thức…), điểm chất lượng, danh sách dòng lỗi |
| Làm sạch | Gợi ý xử lý theo lỗi, xem trước, áp dụng thành phiên bản mới, quay lại phiên bản cũ |
| Mô hình chỉ số | Thực thể, chiều, measure, quan hệ giữa bảng, metric có phiên bản và trạng thái, từ đồng nghĩa, quyền xem theo dòng/cột, thẻ KPI, chạy thử và xem SQL |
| Hỏi đáp AI | Hỏi tiếng Việt, câu hỏi nối tiếp, biểu đồ tự chọn, bảng dữ liệu, nguồn và điểm chất lượng, hỏi lại khi câu mơ hồ, trò chuyện (chào hỏi, hướng dẫn, giải thích chỉ số, nhận xét kết quả), lịch sử hội thoại |
| Dashboard | Ghim từ câu trả lời/KPI/phát hiện, lưới 12 cột, chia sẻ riêng tư hoặc cả tổ chức |
| Điều tra (AI Analyst) | Nêu vấn đề → AI lập kế hoạch phân tích → hệ thống chạy các bước (so sánh kỳ, đóng góp, bất thường, xu hướng…) → báo cáo có phát hiện, giả thuyết, khuyến nghị; mỗi con số bấm vào xem được bằng chứng |
| Vận hành | Trạng thái hệ thống, cảnh báo qua webhook (API, lỗi 5xx, hàng đợi, ổ đĩa, chi phí AI), sao lưu và khôi phục, hạn mức câu hỏi AI mỗi ngày |

## 4. Kiến trúc (tóm tắt)

- **Ứng dụng web** (React) ↔ **API** (NestJS) + **worker** chạy nền (import, kiểm tra chất lượng, làm sạch, điều tra).
- **PostgreSQL**: siêu dữ liệu dùng chung có khóa theo từng tổ chức (Row-Level Security); dữ liệu của mỗi tổ chức nằm
  trong schema riêng. **Redis**: hàng đợi và cache. **S3** (SeaweedFS): lưu file tải lên.
- **AI**: model ngôn ngữ qua API tương thích OpenAI (đang dùng Groq `openai/gpt-oss-120b`), chỉ được gọi các công cụ
  đã định nghĩa (chạy truy vấn ngữ nghĩa, hỏi lại, từ chối, trò chuyện).
- Đóng gói Docker; triển khai pilot: máy Windows + Cloudflare Tunnel (`docs/DEPLOY_LOCAL_TUNNEL.md`), phương án dự
  phòng Oracle Cloud miễn phí (`docs/DEPLOY_ORACLE.md`).

Chi tiết: `docs/ARCHITECTURE.md`, `docs/SEMANTIC_LAYER_DESIGN.md`, `docs/DATABASE_DESIGN.md`; 62 quyết định thiết kế
được ghi trong `docs/DECISIONS.md` (D-01 → D-62).

## 5. Bảo mật và dữ liệu

- Tách biệt tổ chức ở tầng database (RLS bắt buộc + schema riêng); có test tự động kiểm tra tổ chức này không đọc
  được dữ liệu tổ chức khác.
- AI không viết SQL; truy vấn được sinh từ mô hình đã duyệt và kiểm tra lại trước khi chạy; người dùng chỉ xem được
  dữ liệu đúng quyền.
- Mỗi tổ chức tự chọn gửi gì cho AI: mặc định **chỉ siêu dữ liệu** (tên chỉ số, tên cột), không gửi dữ liệu dòng.
- Câu trả lời AI bị chặn nếu chứa số không có trong kết quả, đường link, hoặc lộ hướng dẫn hệ thống; yêu cầu chạy
  SQL hoặc “bỏ qua hướng dẫn” bị từ chối.
- Mật khẩu băm, phiên đăng nhập ngắn hạn, giới hạn tần suất request, nhật ký hoạt động, header bảo mật HTTP.

## 6. Kiểm thử và chất lượng

| Loại | Kết quả gần nhất |
|---|---|
| Unit test | 390 đạt (contracts 4, API 318, web 68) – 10/11/2026 |
| Integration test (database, Redis, S3 thật) | 158 đạt, 3 bỏ qua có chủ đích (hiệu năng, chấm AI thật) – 10/11/2026 |
| E2E (trình duyệt đi hết luồng: đăng ký → dữ liệu → mô hình → hỏi AI → điều tra → dashboard → người xem) | Đạt 4/4 lần trên máy dev 11/11; **lần chạy CI cuối trên `main` không đạt** – đang chờ chạy lại (mục 9) |
| Chấm AI – chế độ kịch bản (oracle) | Hỏi đáp 60/60; điều tra 209/210 (1 lỗi đã biết của bộ phát hiện bất thường) |
| Chấm AI – model thật (Groq) | Mẫu 17/19 câu sau khi sửa 2 lỗi; bộ đầy đủ đang chạy theo đợt mỗi ngày (giới hạn gói miễn phí) |
| Diễn tập khôi phục từ sao lưu | Đạt, khôi phục trong 72 giây, dữ liệu khớp |
| Kiểm tra tự động trên GitHub (CI) | Lint, typecheck, unit, integration, oracle eval, E2E, build image chạy ở mỗi lần push |

Kịch bản test thủ công cho người dùng: `docs/TEST_SCENARIOS.md` (19 kịch bản, kèm dữ liệu mẫu và đáp án).

## 7. Hiệu năng (máy dev, 2 triệu dòng, 20 người dùng đồng thời)

| Hạng mục | Kết quả (p95) | Ngưỡng |
|---|---|---|
| Import 2 triệu dòng (85 MB) | 152 giây | – |
| Truy vấn không có cache | 494 ms | ≤ 3 s |
| Truy vấn có cache | 210 ms | ≤ 300 ms |
| Mở dashboard 10 widget | 595 ms (lạnh: tối đa 2,21 s) | ≤ 5 s |
| Tỷ lệ lỗi | 0 % | < 1 % |

Chi tiết và cách chạy lại: `docs/PERFORMANCE.md`. Cần đo lại trên máy chạy pilot.

## 8. Tiến độ

| Giai đoạn | Nội dung | Trạng thái |
|---|---|---|
| Phase 0 | Nghiên cứu, kiến trúc | ✅ |
| Phase 1 | Nền tảng dự án, CI, hạ tầng | ✅ |
| Phase 2 | Tài khoản, tổ chức, tải và hồ sơ dữ liệu | ✅ |
| Phase 3 | Chất lượng và làm sạch dữ liệu | ✅ |
| Phase 4 | Mô hình chỉ số và bộ máy truy vấn | ✅ |
| Phase 5 | Hỏi đáp AI | ✅ |
| Phase 6 | Dashboard, sẵn sàng vận hành, điều tra AI, E2E, hiệu năng, kế hoạch pilot | ✅ |

Điều kiện bắt đầu pilot (`docs/PILOT.md`):

| # | Điều kiện | Trạng thái |
|---|---|---|
| E1 | CI xanh trên `main` | ⚠️ E2E không đạt ở lần push cuối, đạt trên máy – chờ chạy lại |
| E2 | Hiệu năng đạt ngưỡng | ✅ máy dev; đo lại trên máy pilot |
| E3 | Chấm AI với model thật | 🔄 chạy tự động mỗi tối 21h, ước tính 3–5 ngày |
| E4 | Triển khai lên mạng | 🔄 bộ cài đã diễn tập trên máy; chờ chạy thật + tên miền |
| E5 | Diễn tập khôi phục | ✅ máy dev; làm lại trên máy pilot |
| E6 | Giám sát, cảnh báo | ✅ code; cấu hình khi triển khai |
| E7 | Hạn mức AI, lựa chọn chia sẻ dữ liệu | cấu hình khi triển khai |
| E8 | Thỏa thuận xử lý dữ liệu với khách pilot (Nghị định 13/2023) | ⛔ chưa làm – việc của chủ dự án |

Quy mô mã nguồn: khoảng 51.000 dòng TypeScript, 17 migration database, 66 commit (03/11 → 10/11/2026).

## 9. Rủi ro và vấn đề còn mở

| Vấn đề | Ảnh hưởng | Hướng xử lý |
|---|---|---|
| Gói AI miễn phí (Groq: 200.000 token/ngày) | Chấm AI mất nhiều ngày; người dùng pilot có thể hết lượt hỏi trong ngày | Chấm theo đợt; trước pilot chọn gói trả phí hoặc đặt hạn mức câu hỏi phù hợp |
| E2E trên CI không đạt ở lần push cuối | Chưa đủ điều kiện E1 | Chạy lại job trên GitHub; nếu vẫn lỗi thì xem báo cáo Playwright |
| Máy chạy pilot là máy Windows cá nhân | Máy tắt/khởi động lại thì app ngừng (đã xảy ra đêm 10/11) | Bật tự khởi động Docker và dịch vụ; giám sát uptime bên ngoài; cân nhắc máy chủ riêng |
| Bộ phát hiện bất thường có thể báo nhầm trên chuỗi ~30 điểm | Một phát hiện sai trong báo cáo điều tra | Đã ghi nhận, giữ nguyên ngưỡng; theo dõi trong pilot |
| Chưa đo hiệu năng trên máy pilot, chưa đo nhiều tổ chức lớn cùng lúc | Có thể chậm hơn số đo | Chạy lại k6 trên máy pilot (E2) |
| Chưa có thỏa thuận dữ liệu | Không được nhận dữ liệu thật | Soạn và ký với từng khách (E8) |

## 10. Bước tiếp theo

1. Chạy lại E2E trên GitHub để CI xanh (E1).
2. Theo dõi kết quả chấm AI mỗi tối; khi đủ bộ: chấm ~30 ca điều tra, viết kết quả vào `docs/EVAL_REPORT.md` (E3).
3. Test thủ công theo `docs/TEST_SCENARIOS.md`, sửa lỗi nghiêm trọng/cao.
4. Triển khai thật qua Cloudflare Tunnel, gắn tên miền, chạy smoke test, đo lại hiệu năng và diễn tập khôi phục (E2, E4, E5).
5. Soạn thỏa thuận dữ liệu, chọn 1–3 khách pilot (E8); bắt đầu pilot khi E1–E8 đạt.

## Phụ lục – tài liệu

`docs/STATUS.md` (trạng thái ngắn) · `DEVELOPMENT_PLAN.md` · `DECISIONS.md` · `ARCHITECTURE.md` ·
`SEMANTIC_LAYER_DESIGN.md` · `DATA_QUALITY_DESIGN.md` · `DATABASE_DESIGN.md` · `API_DOCUMENTATION.md` ·
`PERFORMANCE.md` · `EVAL_REPORT.md` · `PILOT.md` · `DEPLOYMENT.md` · `DEPLOY_LOCAL_TUNNEL.md` · `OPERATIONS.md` ·
`FUTURE_ROADMAP.md` · `TEST_SCENARIOS.md`.
