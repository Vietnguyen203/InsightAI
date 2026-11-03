# InsightAI – Future Roadmap (sau MVP)

Các mục dưới đây **không** được triển khai trong MVP. Ghi lại để thiết kế MVP không chặn đường mở rộng.

## Semantic Layer & Query
- Metric `cumulative` (running total, MTD/YTD) và `conversion` (funnel) – theo mô hình MetricFlow.
- Hỗ trợ query qua join one_to_many bằng dedup theo primary key ("multiplied measures" kiểu Cube).
- Pre-aggregation / rollup vật lý hóa; cân nhắc tích hợp Cube như engine thực thi khi workload lớn (IR đã tương thích khái niệm).
- Chế độ "Advanced SQL" cho analyst, đi qua cùng AST validator + role tenant.
- Semantic model import/export dạng YAML (version trong git).
- Nhiều role/membership, ABAC phong phú hơn.

## Data
- Connector: PostgreSQL/MySQL, Google Sheets, ERP/CRM, Google Analytics.
- Lịch import định kỳ, incremental append.
- Retention & archive version cũ sang Parquet trên S3; DuckDB/ClickHouse cho workload lớn – **chỉ khi có benchmark** chứng minh PostgreSQL không đáp ứng.
- Approved cleaning recipe tự chạy khi import mới (MVP: chạy thủ công).
- Presigned upload trực tiếp lên S3 cho file rất lớn (D-26).
- Job "sweeper" đưa lại vào hàng đợi các import kẹt ở PENDING/RUNNING (vd. Redis mất job) – hiện người dùng thấy trạng thái nhưng phải import lại.
- Dọn file S3 và bảng data plane của dataset đã lưu trữ sau thời gian giữ (cần xác nhận người dùng).
- XLSX: shared strings rất lớn đang giữ trong RAM; nếu gặp file thực tế vượt giới hạn, chuyển sang tra cứu theo chỉ mục trên đĩa (D-27).
- Data lineage UI chi tiết theo cột.

## AI
- Anomaly detection, forecasting, predictive analytics, recommendation.
- Giải thích nguyên nhân biến động (drill-down tự động theo dimension).
- Vector search catalog khi số member lớn (> vài nghìn).
- Báo cáo định kỳ tự sinh gửi email/Slack.

## Platform
- Billing & subscription, quota theo gói.
- SSO (Google/Microsoft, SAML), email verification, mời qua email.
- OpenTelemetry tracing, metrics dashboard vận hành.
- Partition `audit_logs`, `query_history`.
- Read replica cho analytics.
- Login role + connection pool riêng mỗi tenant cho data plane (loại bỏ khả năng `SET ROLE` chéo tenant ở tầng DB – xem DECISIONS D-06).
- Route-level code splitting cho frontend (bundle Phase 1 ~536 KB).
- Lint rule ranh giới module backend (`dependency-cruiser`).
