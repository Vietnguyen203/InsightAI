# InsightAI – Pilot plan (Phase 6H-2)

Mục tiêu: chạy thử với **2–3 tổ chức thật trong 4 tuần** để kiểm chứng ba điều trước khi mở rộng: (1) số liệu đúng
và người dùng tin được (data correctness > AI accuracy), (2) người dùng nghiệp vụ tự đi hết hành trình
upload → chất lượng → model/metric → hỏi → điều tra → dashboard, (3) vận hành ổn định với chi phí LLM dự đoán được.
Ý tưởng mới phát sinh trong pilot ghi vào `docs/FUTURE_ROADMAP.md`, không đưa vào code trong lúc pilot.

## 1. Điều kiện bắt đầu pilot (entry gate)

| # | Điều kiện | Cách kiểm tra | Trạng thái 2026-11-09 |
|---|---|---|---|
| E1 | CI xanh trên `main` (lint, unit, integration, oracle eval, E2E, image) | GitHub Actions | ✅ |
| E2 | Hiệu năng đạt ngưỡng PHASE6_AUDIT §6 trên 2 triệu dòng, chạy lại trên hạ tầng production | `docs/PERFORMANCE.md` | ✅ máy dev; chưa chạy trên production |
| E3 | Eval với model thật (`AI_EVAL=true`) đã chạy, có số liệu chi phí/câu | `docs/EVAL_REPORT.md` | ⛔ chờ `OPENAI_API_KEY` |
| E4 | Triển khai production theo `docs/DEPLOYMENT.md`, smoke `docker/smoke.mjs` qua HTTPS | log smoke | chưa làm (chưa chọn hạ tầng) |
| E5 | Diễn tập restore lên máy trống (`docs/OPERATIONS.md` §4), đo RPO/RTO thật | biên bản diễn tập | ✅ máy dev 2026-11-10 (RTO 72 s, dữ liệu khớp); chạy lại trên production |
| E6 | Giám sát: monitor trong worker (API sẵn sàng, 5xx, hàng đợi, đĩa, chi phí LLM/ngày → webhook) + uptime check bên ngoài `/health/live|ready` và heartbeat (`docs/OPERATIONS.md` §6) | `ops-alert-test.js` + một cảnh báo thật FIRING/RESOLVED trên production | ✅ code (D-58); cấu hình khi triển khai |
| E7 | `AI_DAILY_QUESTION_LIMIT` đặt theo ngân sách; `aiDataSharing` của từng org do org đó chọn (mặc định METADATA_ONLY) | cấu hình + trang Cài đặt | cấu hình khi triển khai |
| E8 | Thỏa thuận xử lý dữ liệu với từng org: dữ liệu lưu ở đâu, gửi gì cho OpenAI, xóa khi kết thúc pilot (Nghị định 13/2023) | văn bản ký | chưa làm |

Pilot chỉ bắt đầu khi E1–E8 đều xong (E3 được phép thay bằng giới hạn quota thấp nếu chưa có key eval, nhưng phải ghi rõ).

## 2. Chọn tổ chức pilot

- Có dữ liệu bán hàng/vận hành dạng bảng (CSV/XLSX ≤ 100 MB, ≤ 2 triệu dòng mỗi file) và một người hiểu dữ liệu.
- Có ít nhất một câu hỏi kinh doanh lặp lại hằng tuần (ví dụ "doanh thu tháng này giảm vì đâu").
- Chấp nhận phản hồi mỗi tuần (30 phút) và báo lỗi qua kênh chung.
- Khác nhau về quy mô hoặc ngành để thấy lỗi mô hình hóa khác nhau; ưu tiên 1 org dùng tiếng Việt, 1 org dùng dữ liệu có dấu/định dạng số `vi`.

## 3. Onboarding mỗi tổ chức (tuần 0)

1. Owner đăng ký, đặt timezone/locale, chọn `aiDataSharing` (giải thích METADATA_ONLY vs FULL).
2. Mời thành viên qua link mời: ít nhất 1 analyst (dựng model) và 1 viewer (chỉ xem dashboard).
3. Upload 1–3 dataset; xem hồ sơ dữ liệu và điểm chất lượng; xử lý cảnh báo bằng cleaning (tạo version mới).
4. Dựng semantic model cùng analyst: entity, dimension, measure, relationship → publish; tạo 3–5 metric chính kèm synonym tiếng Việt.
5. Kiểm tra chéo: 3 con số then chốt trên InsightAI khớp với báo cáo hiện có của org (ghi lại chênh lệch và nguyên nhân).
6. Tạo dashboard ORG đầu tiên (ghim từ Hỏi đáp/KPI), chia sẻ cho viewer.
7. Chạy thử 1 cuộc điều tra cho một câu hỏi thật; đọc báo cáo cùng org, giải thích "hạn chế" và evidence.

## 4. Lịch 4 tuần

| Tuần | Trọng tâm | Đầu ra |
|---|---|---|
| 0 | Onboarding (§3) | model + metric publish, số liệu khớp báo cáo cũ |
| 1 | Hỏi đáp hằng ngày, dashboard | phiếu phản hồi tuần 1 |
| 2 | Điều tra cho câu hỏi "vì sao" | ≥ 3 báo cáo điều tra/org, phiếu phản hồi tuần 2 |
| 3 | Dữ liệu mới (import lại, version mới), người xem tự dùng dashboard | phiếu phản hồi tuần 3 |
| 4 | Tổng kết, quyết định go-live | biên bản §7 |

## 5. Chỉ số theo dõi

Lấy từ dữ liệu sẵn có (`query_history`, `conversations`/`messages`, `investigations`, `llm_usage`, `audit_logs`) bằng truy vấn quản trị chỉ đọc; không xuất dữ liệu nghiệp vụ của org ra ngoài.

| Nhóm | Chỉ số | Mục tiêu pilot |
|---|---|---|
| Đúng số liệu | Chênh lệch con số then chốt so với nguồn của org | 0 (mọi chênh lệch phải giải thích được) |
| Đúng số liệu | Báo cáo sai số liệu do hệ thống (không phải do dữ liệu nguồn) | 0 |
| AI | Tỷ lệ câu trả lời `ANSWERED` / `CLARIFICATION` / `CANNOT_ANSWER` | ANSWERED ≥ 70 %, CANNOT_ANSWER được người dùng đánh giá là hợp lý |
| AI | Câu trả lời người dùng đánh giá "đúng ý" (phiếu §6) | ≥ 80 % |
| Điều tra | Tỷ lệ COMPLETED / PARTIAL / FAILED; phát hiện được đánh giá hữu ích | FAILED < 5 %; ≥ 1 phát hiện hữu ích/báo cáo |
| Sử dụng | Người dùng hoạt động/tuần, câu hỏi/tuần, dashboard được mở | tăng hoặc ổn định qua tuần 1–3 |
| Vận hành | Uptime, lỗi 5xx, p95 truy vấn, hàng đợi tồn | uptime ≥ 99 % giờ làm việc; p95 như `docs/PERFORMANCE.md` |
| Chi phí | Token và USD/ngày/org từ `llm_usage` | trong ngân sách đã chốt ở E7 |

## 6. Phiếu phản hồi hằng tuần (mỗi org, 30 phút)

```
Tổ chức: ……   Tuần: …   Người trả lời (vai trò): ……

1. Câu hỏi/điều tra quan trọng nhất tuần này là gì? InsightAI trả lời được không? (Có / Một phần / Không)
2. Có con số nào bạn nghi ngờ hoặc khác báo cáo của bạn không? (mô tả, kèm link câu trả lời/dashboard)
3. Câu trả lời có hiểu đúng ý câu hỏi không? Ví dụ hiểu sai: ……
4. Báo cáo điều tra: phát hiện nào hữu ích? phát hiện nào sai/thừa? phần "hạn chế" có dễ hiểu không?
5. Bước nào mất nhiều thời gian nhất (upload, chất lượng, dựng model, metric, dashboard)?
6. Lỗi gặp phải (thời điểm, màn hình, thông báo lỗi):
7. Mức độ tin cậy vào số liệu (1–5): …   Mức độ muốn tiếp tục dùng (1–5): …
8. Một điều cần sửa ngay / một điều muốn có thêm:
```

Mỗi mục được phân loại: **lỗi đúng số liệu** (P0) · **lỗi chức năng** (P1/P2) · **trải nghiệm** · **ý tưởng** (→ FUTURE_ROADMAP).

## 7. Xử lý sự cố trong pilot

| Mức | Ví dụ | Phản hồi | Xử lý |
|---|---|---|---|
| P0 | Số liệu sai do hệ thống, lộ dữ liệu giữa tổ chức, mất dữ liệu | trong 4 giờ làm việc | tạm khóa tính năng liên quan, sửa trên nhánh `fix/…` có test tái hiện, thông báo org bị ảnh hưởng |
| P1 | Import/điều tra thất bại liên tục, không đăng nhập được | trong 1 ngày | sửa trong tuần |
| P2 | Lỗi giao diện, câu trả lời AI chưa tốt nhưng số liệu đúng | gom theo tuần | ưu tiên theo tần suất |

Mọi lỗi lộ dữ liệu giữa tổ chức là điều kiện **dừng pilot** cho tới khi có test tái hiện và bản sửa đã qua CI.

## 8. Tiêu chí go-live (exit criteria)

Go-live (mở cho khách hàng trả phí) khi **tất cả** đúng:

1. Không còn lỗi P0 mở; không có sự cố lộ dữ liệu giữa tổ chức trong suốt pilot.
2. Con số then chốt của mọi org pilot khớp nguồn (hoặc chênh lệch đã giải thích bằng dữ liệu nguồn).
3. ≥ 2/3 org trả lời "muốn tiếp tục dùng" ≥ 4/5 ở tuần 4; độ tin cậy số liệu trung bình ≥ 4/5.
4. Eval model thật (E3) đạt ngưỡng của `docs/EVAL_REPORT.md`; chi phí LLM/org/tháng nằm trong giá gói dự kiến.
5. Uptime và p95 đạt §5; restore đã diễn tập thành công (E5) và cảnh báo vận hành đã thử (E6).
6. Tài liệu `DEPLOYMENT.md`/`OPERATIONS.md` đủ để người khác triển khai lại; dữ liệu pilot được xóa hoặc chuyển giao theo thỏa thuận (E8).

Nếu không đạt: ghi nguyên nhân, kéo dài pilot tối đa 4 tuần với danh sách sửa cụ thể, không thêm tính năng mới.
