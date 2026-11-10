# InsightAI – Semantic Layer Design

> Trạng thái: **Phase 0 – Proposed**. Đây là một trong hai lõi kỹ thuật. Quyết định liên quan: D-03, D-07, D-08, D-10 trong [DECISIONS.md](DECISIONS.md).

Mục tiêu: một metric chỉ có **một** định nghĩa chuẩn tại một thời điểm; mọi đường truy cập (KPI API, dashboard, AI) đều đi qua **cùng một compiler**; AI chỉ chọn trong catalog, không suy diễn công thức.

---

## 1. Nghiên cứu các nền tảng tham khảo

> Dựa trên tài liệu công khai của các dự án (đến 2026). Mục tiêu là rút ra ý tưởng, không tích hợp cả ba.

### 1.1 dbt Semantic Layer / MetricFlow

**Data model**
- `semantic_model`: gắn với một model dbt (một bảng). Gồm:
  - `entities`: khóa join, loại `primary | unique | foreign | natural`. Join **không khai báo tường minh**; MetricFlow tự suy ra join khi hai semantic model chia sẻ cùng tên entity (vd. `customer` là primary ở `customers`, foreign ở `orders`).
  - `dimensions`: `categorical` hoặc `time` (có `time_granularity`). Mỗi dimension thuộc về một semantic model, được tham chiếu qua entity path: `order__customer__region`.
  - `measures`: aggregation (`sum, count, count_distinct, average, min, max, percentile, sum_boolean`) trên `expr`, có `agg_time_dimension`, có thể `non_additive_dimension` (vd. số dư cuối kỳ).
- `metrics` tách biệt với measures, nhiều loại: `simple` (1 measure + filter), `ratio` (numerator/denominator), `derived` (biểu thức trên metric khác, có `offset_window` cho so sánh kỳ trước), `cumulative` (window/grain-to-date), `conversion`.

**Query planning & SQL generation**
- Request = `metrics + group_by + where + order_by + limit` (MetricFlow query spec).
- MetricFlow xây **dataflow plan**: với mỗi measure → đọc nguồn → join các semantic model cần cho dimension (theo entity graph) → filter → aggregate → kết hợp các measure khác nguồn bằng **join trên các group-by dimension** sau khi đã aggregate → tính metric (ratio/derived) ở tầng ngoài → render SQL theo dialect.
- Chống fan-out: join chỉ được phép theo hướng an toàn (từ foreign tới primary/unique — tức many-to-one / one-to-one). Join "fan-out" bị từ chối, hoặc phải xử lý bằng multi-hop hạn chế.

**Access control**: dựa trên quyền của warehouse/credential trong dbt Cloud; không có row-level policy giàu ngữ nghĩa trong semantic layer.

**LLM**: dbt cung cấp MCP server / Semantic Layer API (JDBC, GraphQL) để LLM liệt kê metric, dimension rồi gửi query spec — tức là **LLM tạo query spec chứ không tạo SQL**. Đây là pattern InsightAI sẽ dùng.

**Đánh giá cho InsightAI**: mô hình khái niệm tốt nhất (tách measure/metric, entity-based join, plan rồi mới render SQL). Nhưng: engine viết bằng Python, gắn với workflow dbt project (YAML trong git, `dbt build`), API hosted nằm trong dbt Cloud. Dataset của InsightAI do người dùng upload động, mỗi tenant khác nhau → không phù hợp để chạy dbt project/tenant.

### 1.2 Cube

**Data model**
- `cube`: một bảng hoặc `sql` tùy ý; có `measures` (`count, sum, avg, min, max, count_distinct, count_distinct_approx, number` cho công thức), `dimensions` (`string, number, time, boolean`, có `primary_key`), `segments` (filter đặt tên — gần với filter trong metric).
- `joins` khai báo **tường minh** với `relationship: one_to_one | one_to_many | many_to_one`.
- `views`: lớp trình bày, chọn các member từ nhiều cube theo join path cố định — giúp tránh mơ hồ khi có nhiều đường join.
- `pre_aggregations`: rollup vật lý hóa (cache) – quan trọng cho hiệu năng.

**Query planning & SQL generation**
- Query JSON: `measures, dimensions, timeDimensions{dimension, granularity, dateRange, compareDateRange}, filters, segments, order, limit`.
- Chống fan-out: khi query gồm measures từ cube có quan hệ one_to_many, Cube dùng **primary key của cube để dedup** (aggregate trong subquery theo primary key rồi join) – "multiplied measures". Đây là kỹ thuật cần học.
- Có `compareDateRange` cho so sánh kỳ.

**Access control & multi-tenancy**
- `securityContext` (từ JWT) → `queryRewrite` (inject filter), `access_policy` khai báo theo role (member-level + row-level), `contextToAppId` / `driverFactory` / `scheduledRefreshContexts` để mỗi tenant có data model / DB riêng.

**LLM**: Cube có AI API / semantic catalog cho agent; pattern cũng là LLM → Cube query JSON.

**Đánh giá**: gần nhất về kỹ thuật (Node.js-based, REST API, multi-tenant, access policy). Nhược điểm cho InsightAI: data model là file code (YAML/JS) trong repository; mô hình động/tenant phải tự sinh file và cấu hình `repositoryFactory` + quản lý compile cache cho mỗi tenant; thêm một service phải vận hành (Cube API + Cube Store cho pre-aggregation); khó gắn chặt với dataset version, quality status, metric versioning, synonym mà InsightAI cần; license core Apache 2.0 nhưng nhiều tính năng (AI, một số tính năng semantic/catalog) nằm trong Cube Cloud.

### 1.3 Apache Superset semantic modeling

- Đơn vị là `dataset` (physical table hoặc virtual = SQL query). Trên dataset định nghĩa **metrics** (biểu thức SQL tự do, vd. `SUM(amount)`) và **calculated columns**.
- **Không có mô hình join/relationship**: muốn kết hợp bảng phải viết virtual dataset bằng SQL → toàn bộ trách nhiệm chống double counting đẩy về người viết SQL.
- Access control: role-based tới database/schema/dataset + **Row Level Security filters** (mệnh đề SQL gắn với role và table).
- Đánh giá: bài học tích cực là **RLS filter gắn với role** và "dataset-level metric" đơn giản cho người dùng. Bài học tiêu cực: metric là SQL tự do + không có join model → đây chính là kiểu "semantic layer đơn giản" mà InsightAI phải tránh.

### 1.4 Tổng hợp ý tưởng sẽ áp dụng

| Ý tưởng | Nguồn | Áp dụng trong InsightAI |
|---|---|---|
| Tách **measure** (aggregation thô) và **metric** (định nghĩa nghiệp vụ, có filter, đơn vị, version) | MetricFlow | ✅ |
| Metric types simple / ratio / derived | MetricFlow | ✅ MVP; cumulative & conversion → roadmap |
| Query spec (metrics + dimensions + filters + time) làm giao diện cho LLM | MetricFlow, Cube | ✅ Semantic Query IR |
| Plan → rồi mới render SQL; aggregate từng nguồn rồi join trên dimension | MetricFlow | ✅ |
| Join tường minh có cardinality | Cube | ✅ (dễ hiểu cho người dùng hơn entity-name matching) |
| Dedup measure bằng primary key khi buộc phải đi qua one_to_many | Cube | ⏸ MVP từ chối query fan-out; roadmap |
| Time dimension + granularity + compareDateRange | Cube | ✅ |
| Access policy theo role: member-level + row-level | Cube, Superset RLS | ✅ |
| Segments / named filters | Cube | ✅ dưới dạng filter của metric |
| Pre-aggregation / rollup | Cube | ⏸ roadmap (chỉ cache kết quả Redis trong MVP) |
| Metric = SQL tự do | Superset | ❌ Không – dùng Expression DSL hạn chế |

---

## 2. So sánh phương án

Thang điểm 1 (kém) – 5 (tốt) cho bối cảnh InsightAI (dataset động, đa tenant, Node.js, LLM-first, đội nhỏ).

| Tiêu chí | Tự xây (lấy cảm hứng MetricFlow + Cube) | Tích hợp Cube | Tích hợp dbt / MetricFlow |
|---|---|---|---|
| Độ phức tạp ban đầu | 3 – phải tự viết planner/compiler (phạm vi giới hạn) | 3 – ít code engine, nhưng phải sinh data model động/tenant + vận hành service | 1 – cần dbt project/tenant, Python runtime, hoặc dbt Cloud |
| Khả năng tùy chỉnh | 5 | 3 – trong giới hạn data model & extension points của Cube | 2 |
| Tích hợp Node.js | 5 – cùng process, cùng type | 4 – REST/SQL API, model JS | 1 – Python CLI / API cloud |
| Tích hợp LLM | 5 – IR do mình thiết kế, sinh JSON Schema cho tool calling, synonym, clarification | 4 | 3 |
| Gắn với Data Quality / dataset version / metric version | 5 | 2 – phải đồng bộ hai nguồn metadata | 1 |
| Hiệu năng | 3 – đủ cho MVP; không có pre-aggregation | 5 – pre-aggregation, Cube Store | 4 – đẩy xuống warehouse |
| Mở rộng thương mại | 4 – sở hữu IP lõi, không phụ thuộc license | 3 – phụ thuộc lộ trình Cube; tính năng AI/catalog nằm ở Cloud | 2 |
| Chi phí phát triển | 3 | 4 | 2 |
| Chi phí vận hành | 5 – không thêm service | 3 – thêm Cube API + Cube Store + Redis | 2 |
| **Tổng** | **38** | **31** | **18** |

### Khuyến nghị: Tự xây Semantic Layer gọn, có chủ đích (D-07)

Phạm vi tự xây được khoanh rõ để không over-engineer:
- Chỉ dialect PostgreSQL.
- Chỉ metric simple / ratio / derived + time comparison ở mức query.
- Join graph: chỉ đường many-to-one / one-to-one từ entity chứa measure; tối đa 3 hop.
- Không pre-aggregation (cache kết quả theo hash IR + dataset version trong Redis).

Đường lui: **Semantic Query IR được thiết kế gần với Cube query format**, và metadata semantic lưu ở DB có cấu trúc tương đương cube/measure/dimension/join → nếu sau này cần pre-aggregation quy mô lớn, có thể sinh Cube data model từ metadata và chuyển compiler sang Cube mà không đổi API cho frontend/LLM.

---

## 3. Mô hình khái niệm

```mermaid
erDiagram
  SEMANTIC_MODEL ||--o{ ENTITY : contains
  ENTITY }o--|| DATASET : "source (active version)"
  ENTITY ||--o{ DIMENSION : has
  ENTITY ||--o{ MEASURE : has
  SEMANTIC_MODEL ||--o{ RELATIONSHIP : defines
  RELATIONSHIP }o--|| ENTITY : from
  RELATIONSHIP }o--|| ENTITY : to
  SEMANTIC_MODEL ||--o{ METRIC : publishes
  METRIC ||--o{ METRIC_VERSION : "versions (≤1 PUBLISHED)"
  METRIC_VERSION }o--o| MEASURE : "simple: uses"
  METRIC_VERSION }o--o{ METRIC : "ratio/derived: uses"
  METRIC_VERSION }o--o| DIMENSION : "time dimension"
  SEMANTIC_MODEL ||--o{ ACCESS_POLICY : governs
  SYNONYM }o--|| METRIC : "alias of (also dimension)"
```

| Khái niệm | Định nghĩa trong InsightAI | Ví dụ |
|---|---|---|
| **Semantic Model** | Không gian nghiệp vụ trong một org (vd. "Bán hàng"). Đơn vị publish & phân quyền. MVP: nhiều model/org, metric thuộc 1 model | Sales |
| **Entity** | Một khái niệm nghiệp vụ có định danh, ánh xạ tới một dataset; có `primary_key` (1+ cột) xác định **grain** | Order (grain: order_id), Product, Customer |
| **Dimension** | Thuộc tính để group/filter. `categorical` hoặc `time` (granularities cho phép). Nguồn: một cột hoặc Expression DSL trên cột cùng entity | Order Date, Product Category, Region |
| **Measure** | Aggregation thô trên entity: `sum, count, count_distinct, avg, min, max`. Không có filter nghiệp vụ, không có ý nghĩa "chuẩn" với người dùng cuối | `total_amount = SUM(total_amount)`, `order_count = COUNT(order_id)` |
| **Metric** | Định nghĩa nghiệp vụ chuẩn, có version, đơn vị, định dạng, business definition, filter, time dimension mặc định. **Thứ duy nhất LLM và KPI API được truy vấn** | Total Revenue, AOV, Paid Orders |
| **Relationship** | Join tường minh giữa 2 entity với cặp cột và cardinality `many_to_one | one_to_one` (khai báo theo hướng; `one_to_many` là chiều ngược của `many_to_one`) | Order.product_id → Product.id (many_to_one) |
| **Business Definition** | Mô tả bằng ngôn ngữ tự nhiên + owner + ghi chú tính toán; hiển thị cho user và đưa vào catalog cho LLM | "Tổng giá trị các đơn hàng đã thanh toán thành công" |
| **Access Policy** | Quy tắc theo role: member-level (được thấy metric/dimension nào) + row-level (filter bắt buộc, có thể tham chiếu thuộc tính user) | Role `sales_north`: `region IN ('North')` |
| **Synonym** | Cụm từ người dùng hay dùng → member chuẩn. Phục vụ semantic mapping | "doanh số", "revenue", "doanh thu" → Total Revenue |

### 3.1 Ví dụ hoàn chỉnh (YAML chỉ để minh họa – thực tế lưu DB & chỉnh qua UI/API)

```yaml
semantic_model: sales
entities:
  - name: order
    dataset: orders            # dataset_id, dùng active version
    primary_key: [order_id]
    dimensions:
      - { name: order_date, type: time, column: created_at, granularities: [day, week, month, quarter, year] }
      - { name: paid_at,    type: time, column: paid_at,    granularities: [day, month, year] }
      - { name: payment_status, type: categorical, column: payment_status }
      - { name: region, type: categorical, column: region }
    measures:
      - { name: total_amount_sum, agg: sum,   expr: total_amount }
      - { name: order_count,      agg: count_distinct, expr: order_id }
  - name: order_item
    dataset: order_items
    primary_key: [order_item_id]
    measures:
      - { name: quantity_sum, agg: sum, expr: quantity }
      - { name: line_revenue, agg: sum, expr: "quantity * unit_price" }
  - name: product
    dataset: products
    primary_key: [product_id]
    dimensions:
      - { name: product_name, type: categorical, column: name }
      - { name: product_category, type: categorical, column: category }
relationships:
  - { from: order_item, to: order,   on: [[order_id, order_id]],     cardinality: many_to_one }
  - { from: order_item, to: product, on: [[product_id, product_id]], cardinality: many_to_one }
metrics:
  - name: total_revenue
    label: Total Revenue
    type: simple
    measure: order.total_amount_sum
    filter: "payment_status = 'PAID'"
    time_dimension: order.paid_at
    unit: VND
    format: currency
    business_definition: Tổng giá trị các đơn hàng đã thanh toán thành công.
    synonyms: [doanh thu, doanh số, revenue, tổng doanh thu]
  - name: paid_orders
    type: simple
    measure: order.order_count
    filter: "payment_status = 'PAID'"
    time_dimension: order.paid_at
  - name: total_orders
    type: simple
    measure: order.order_count
    time_dimension: order.order_date
  - name: average_order_value
    type: ratio
    numerator: total_revenue
    denominator: paid_orders
    unit: VND
    business_definition: Doanh thu trung bình trên mỗi đơn đã thanh toán.
  - name: product_revenue
    type: simple
    measure: order_item.line_revenue
    filter: "order.payment_status = 'PAID'"   # filter qua join many_to_one: an toàn
    time_dimension: order.paid_at
```

Lưu ý thiết kế: "Top 10 sản phẩm có doanh thu cao nhất" phải dùng `product_revenue` (grain order_item) chứ không phải `total_revenue` group by product (grain order → fan-out sang order_item). Planner sẽ **từ chối** `total_revenue BY product_category` vì đường join từ `order` tới `product` phải đi qua `order_item` theo hướng one_to_many (§6.3). Đây chính là cơ chế chống double counting.

---

## 4. Expression DSL (dùng chung với Data Quality)

Người dùng **không** nhập SQL. Mọi `expr`, `filter`, rule consistency đều viết bằng DSL hạn chế:

- Literal: số, chuỗi `'...'`, `true/false`, `null`, ngày `date '2026-01-01'`.
- Tham chiếu cột: `col` (cùng entity) hoặc `entity.col` (chỉ trong filter của metric, phải đi qua relationship many_to_one).
- Toán tử: `+ - * /`, `= != < <= > >=`, `AND OR NOT`, `IN (...)`, `IS [NOT] NULL`, `BETWEEN`, `LIKE` (không regex trong semantic), `CASE WHEN ... THEN ... ELSE ... END`.
- Hàm allowlist: `coalesce, nullif, lower, upper, trim, abs, round, date_trunc, extract, length`.
- Parser: viết bằng một thư viện parser combinator nhỏ / Pratt parser tự viết (~400 LOC) → AST có kiểu → **type-check** với kiểu cột của dataset version → compile ra SQL fragment với identifier đã quote và literal là bind parameter.

Lợi ích: một chỗ duy nhất kiểm soát an toàn biểu thức; kiểm tra được tham chiếu khi dataset version đổi schema; hiển thị lại được cho người dùng.

---

## 5. Semantic Query IR (hợp đồng giữa LLM / UI / KPI API và engine)

Định nghĩa trong `packages/contracts` bằng Zod; JSON Schema cho tool calling sinh từ đó.

```ts
type SemanticQuery = {
  model: string;                       // semantic model key
  metrics: string[];                   // 1..5 metric keys (published)
  dimensions?: string[];               // "entity.dimension", ≤ 3
  timeDimension?: {
    dimension?: string;                // mặc định = time_dimension của metric
    granularity?: 'day'|'week'|'month'|'quarter'|'year';
    dateRange: { preset: 'this_month'|'last_month'|'last_7_days'|'this_year'|... }
             | { from: string; to: string };          // ISO date, tz của org
    compareTo?: 'previous_period' | 'same_period_last_year';
  };
  filters?: Array<{ member: string; op: 'eq'|'neq'|'in'|'not_in'|'gt'|'gte'|'lt'|'lte'|'contains'|'is_null'|'not_null';
                    values?: (string|number|boolean)[] }>;
  orderBy?: Array<{ member: string; dir: 'asc'|'desc' }>;
  limit?: number;                      // ≤ 1000 (mặc định 100)
};
```

Đặc điểm:
- Chỉ tham chiếu **key** của member, không có biểu thức → không có bề mặt injection.
- `dateRange.preset` được resolve phía server theo timezone org (`Asia/Ho_Chi_Minh` mặc định) và "ngày hiện tại" của server — LLM không tự tính ngày.
- Hash của IR (chuẩn hóa) + `dataset_version_ids` + `metric_version_ids` + policy fingerprint = cache key.

Ví dụ ánh xạ câu hỏi:

| Câu hỏi | IR |
|---|---|
| Doanh thu tháng này là bao nhiêu? | `metrics:[total_revenue], timeDimension:{dateRange:{preset:this_month}}` |
| So sánh doanh thu tháng này với tháng trước | `… dateRange:{preset:this_month}, compareTo: previous_period` |
| Top 10 sản phẩm có doanh thu cao nhất | `metrics:[product_revenue], dimensions:[product.product_name], orderBy:[{member:product_revenue,dir:desc}], limit:10` |
| Số đơn thành công theo từng tháng | `metrics:[paid_orders], timeDimension:{granularity:month, dateRange:{preset:this_year}}` |
| Giá trị đơn hàng trung bình là bao nhiêu? | `metrics:[average_order_value]` (dateRange mặc định của metric/org – nêu rõ trong câu trả lời) |

---

## 6. Query Planning & SQL Generation

### 6.1 Các bước compiler

1. **Resolve**: key → metric version PUBLISHED, measure, dimension, entity, dataset active version, physical table, cột vật lý. Lỗi → `QueryRejectedError` có mã (`UNKNOWN_METRIC`, `DIMENSION_NOT_REACHABLE`, …) để LLM/clarification xử lý.
2. **Authorize members**: mỗi metric/dimension/filter member phải nằm trong tập được phép của user (access policy member-level). Member không được phép → coi như không tồn tại (không lộ sự tồn tại).
3. **Expand metrics** thành tập measure cần tính: simple → 1 measure + filter; ratio → 2 metric con; derived → cây metric (phát hiện vòng lặp lúc publish, không lúc query).
4. **Group measure theo (entity nguồn, filter)** → mỗi nhóm là một "measure source".
5. **Join planning** cho mỗi measure source: tìm đường trong relationship graph từ entity nguồn tới entity của mỗi dimension/filter, **chỉ đi theo cạnh many_to_one / one_to_one** (BFS, ≤ 3 hop, đường phải duy nhất; nếu có ≥ 2 đường cùng độ dài → lỗi `AMBIGUOUS_JOIN_PATH`, yêu cầu admin khai báo `preferred` trên relationship).
6. **Row-level policy injection**: với mỗi entity xuất hiện trong plan, thêm filter của access policy áp dụng cho user (AND với nhau). Nếu policy tham chiếu entity không join được an toàn từ nguồn → từ chối query (fail closed).
7. **Time handling**: resolve dateRange → `[from, to)`, áp lên time dimension của metric; `granularity` → `date_trunc`. `compareTo` → tính thêm một plan với range dịch kỳ, ghép theo bucket offset.
8. **Render SQL**: mỗi measure source → một CTE aggregate theo các dimension yêu cầu; CTE kết hợp bằng `FULL OUTER JOIN … USING (dimension cols)` (hoặc cross join khi không có dimension); select ngoài tính ratio/derived với `NULLIF(denominator, 0)`; `ORDER BY`, `LIMIT min(limit, hardLimit)+1` (để biết bị cắt).
9. Trả về `CompiledQuery { sql, params, columns[{key, type, unit, format}], provenance }`.

### 6.2 Ví dụ SQL sinh ra (AOV theo tháng 2026)

```sql
WITH s1 AS (               -- source: order, filter payment_status='PAID'
  SELECT date_trunc('month', o."paid_at" AT TIME ZONE $1) AS "d_month",
         SUM(o."total_amount")                     AS "m_total_revenue",
         COUNT(DISTINCT o."order_id")              AS "m_paid_orders"
  FROM "t_8f3k2"."ds_orders_v3" o
  WHERE o."payment_status" = $2
    AND o."paid_at" >= $3 AND o."paid_at" < $4
    AND (o."region" = ANY($5))                    -- injected row-level policy
  GROUP BY 1
)
SELECT "d_month",
       "m_total_revenue" / NULLIF("m_paid_orders", 0) AS "average_order_value"
FROM s1
ORDER BY "d_month"
LIMIT 1001
```

### 6.3 Chống fan-out / double counting

Quy tắc bất biến: **một measure chỉ được aggregate tại grain của entity nguồn hoặc thô hơn**. Join từ entity nguồn chỉ được đi tới entity "một" (many_to_one / one_to_one), vì những join này không nhân bản dòng nguồn.

| Tình huống | Hành vi MVP |
|---|---|
| `total_revenue BY product.product_name` (order → order_item là one_to_many) | Từ chối `FANOUT_JOIN`: thông báo + gợi ý metric `product_revenue` nếu tồn tại metric cùng nghĩa ở grain phù hợp |
| `total_revenue, quantity_sum BY order.region` (2 nguồn: order, order_item) | Hợp lệ: 2 CTE, CTE order_item join many_to_one tới order để lấy region, rồi FULL JOIN trên region |
| Relationship khai báo many_to_one nhưng dữ liệu thực có trùng khóa ở phía "một" | Phát hiện bằng **semantic validation** (§7): kiểm tra uniqueness của khóa phía "một" trên dataset version; vi phạm → relationship `INVALID`, metric phụ thuộc không chạy được. Đây là điểm Semantic Layer nối với Data Quality |

Roadmap: hỗ trợ fan-out bằng dedup theo primary key (kỹ thuật "multiplied measures" của Cube).

### 6.4 SQL AST validation (phòng thủ chiều sâu)

SQL do compiler sinh ra, nhưng vẫn được kiểm tra trước khi chạy – để bắt lỗi compiler và để sẵn sàng nếu sau này cho phép SQL nâng cao:
- Parse bằng **parser thật của PostgreSQL** (`libpg-query` – bản WASM, không cần native build; spike Phase 5, fallback `pgsql-ast-parser`).
- Đúng 1 statement; root là `SelectStmt`; không có `INTO`, `FOR UPDATE/SHARE`, không có DML/DDL lồng (CTE `INSERT/UPDATE/DELETE` – Postgres cho phép `WITH x AS (DELETE …)`, nên **không thể chỉ kiểm tra từ khóa SELECT**).
- Mọi `RangeVar` phải thuộc schema của tenant hiện tại và nằm trong tập bảng của plan.
- Hàm: allowlist (`sum, count, avg, min, max, date_trunc, coalesce, nullif, …`); cấm `pg_sleep`, `dblink`, `lo_*`, `pg_read_file`, `set_config`, `current_setting`, mọi hàm không trong danh sách.
- Không có comment, không có tham chiếu `pg_catalog`/`information_schema`.

Lớp phòng thủ tầng DB (không phụ thuộc validator):
- Kết nối bằng pool `analytics` user không có quyền nào ngoài `GRANT t_xxx_reader TO analytics`; mỗi query: `BEGIN READ ONLY; SET LOCAL ROLE t_xxx_reader; SET LOCAL search_path = t_xxx; SET LOCAL statement_timeout = '15s'; SET LOCAL work_mem = '64MB'; … ; COMMIT`.
- `t_xxx_reader` chỉ có `USAGE` trên schema của tenant và `SELECT` trên bảng dataset; không có quyền trên schema `app`.

---

## 7. Lifecycle, versioning & semantic validation

- Dimension/measure/entity/relationship: chỉnh sửa trực tiếp ở trạng thái `DRAFT` của semantic model; mỗi lần **publish model** chạy semantic validation.
- Metric: bản ghi `metrics` (định danh ổn định, key) + `metric_versions` (bất biến sau khi publish). Trạng thái version: `DRAFT → PUBLISHED → DEPRECATED`. **Ràng buộc DB**: partial unique index `(metric_id) WHERE status='PUBLISHED'` → đảm bảo "một định nghĩa chuẩn tại một thời điểm" ở tầng DB, không chỉ tầng code.
- `query_history` lưu `metric_version_id` → câu trả lời cũ vẫn truy vết được định nghĩa đã dùng kể cả khi metric đã đổi.
- Đổi tên/xóa: metric đang được dashboard dùng không xóa cứng; chỉ `DEPRECATED` (ẩn khỏi catalog LLM, dashboard hiển thị cảnh báo).

Semantic validation (chạy khi publish model/metric và khi dataset đổi active version):
1. Mọi cột tham chiếu tồn tại trong active version với kiểu tương thích (measure `sum/avg` cần numeric; time dimension cần date/timestamp).
2. Expression DSL type-check thành công.
3. Primary key của entity unique & not null trên dữ liệu (SQL check, dùng chung engine với Data Quality uniqueness).
4. Relationship: khóa phía "một" unique; tỉ lệ khóa foreign không tìm thấy (orphan) được báo cáo (cảnh báo, không chặn).
5. Graph: không có đường join mơ hồ; metric derived không có vòng.
6. Dataset nguồn có quality score ≥ ngưỡng do org cấu hình (mặc định cảnh báo, không chặn – D-11).
Kết quả: `VALID | WARNING | INVALID` + danh sách lỗi; metric phụ thuộc thành phần INVALID không được truy vấn.

---

## 8. Access Policy

```ts
type AccessPolicy = {
  roleIds: string[];                         // áp cho role nào (role của org)
  memberAccess?: { include?: string[]; exclude?: string[] };   // pattern "entity.*", "metric:total_revenue"
  rowFilter?: { entity: string; expr: string };                // DSL; có thể dùng {{user.attr.region}}
};
```
- Nhiều policy áp cho một user: member access = hợp các include trừ các exclude; row filter giữa các policy khác nhau là **OR** (giống Cube: user được quyền theo bất kỳ policy nào), trong một policy là AND. Không có policy nào áp → mặc định theo permission RBAC: `semantic:query` thấy toàn bộ model, không row filter (org nhỏ không phải cấu hình gì).
- User attributes (vd. `region`) lưu trên membership (`memberships.attributes` JSONB), giá trị đưa vào SQL dưới dạng bind param.
- Catalog gửi cho LLM được **lọc theo policy trước** → LLM không biết đến member bị cấm.
- Owner/Admin có thể "xem như role X" để test policy (audit log).

---

## 9. Tích hợp LLM

### 9.1 Tools (function calling)

| Tool | Mục đích | Do ai thực thi |
|---|---|---|
| `search_catalog(query)` | Tìm metric/dimension theo từ khóa + synonym (trigram `pg_trgm` + unaccent cho tiếng Việt) | Backend, trả về tối đa 20 member có mô tả |
| `get_dimension_values(dimension, prefix)` | Tra giá trị thực để ánh xạ "miền Bắc" → `'North'` | Backend, chỉ dimension categorical, ≤ 50 giá trị, theo policy |
| `run_semantic_query(ir)` | Kết thúc giai đoạn hiểu câu hỏi | Backend validate + compile + chạy |
| `ask_clarification(question, options[])` | Khi mơ hồ / thiếu thông tin | Trả về user |
| `cannot_answer(reason)` | Không có metric phù hợp | Trả về user, gợi ý metric gần nhất |
| `reply(message, suggestions[])` | Chào hỏi, hướng dẫn, giải thích metric, bàn luận kết quả đã hiển thị (D-62) | Trả về user (`CHAT`); chỉ được nhắc lại số đã hiển thị trong hội thoại |

Vòng lặp tool calling giới hạn 6 bước / câu hỏi. Prompt hệ thống cố định: chỉ được dùng member trả về từ catalog, không tự tạo công thức, không đưa ra con số.

Catalog nhỏ (< ~150 member) được đưa thẳng vào system prompt dạng nén (key, label, mô tả ngắn, synonym) – rẻ và chính xác hơn tìm kiếm. Catalog lớn hơn mới dùng `search_catalog`. **Không dùng vector DB/RAG trong MVP.**

### 9.2 Diễn giải kết quả không sinh số
- Input cho LLM: câu hỏi, IR đã chạy, metadata cột (label, unit), **tối đa 50 dòng kết quả** + các tổng hợp do backend tính sẵn (tổng, % thay đổi khi có compareTo, min/max).
- LLM trả JSON `{ narrative: string, highlights: [...] }` trong đó mọi số phải là placeholder `{{cell:<row>.<col>}}` hoặc `{{stat:<name>}}`. Backend render bằng formatter theo unit/format/locale.
- Nếu narrative chứa chữ số không nằm trong placeholder (regex) → loại narrative, dùng template tất định ("Doanh thu tháng 11/2026 là 1.234.000.000 ₫, tăng 12,4% so với tháng 10/2026.").

### 9.3 Provenance trả về cùng mọi câu trả lời
```json
{ "queryHistoryId": "…", "interpretedAs": "Total Revenue · theo tháng · 01/11/2026–30/11/2026",
  "metrics": [{"key":"total_revenue","version":3,"definition":"Tổng giá trị…"}],
  "datasets": [{"id":"…","name":"orders","version":5,"qualityScore":96.2}],
  "sql": "…", "rowCount": 1, "truncated": false, "policiesApplied": ["sales_north"] }
```

### 9.4 Provider abstraction
```ts
interface LlmProvider {
  chat(req: { messages: LlmMessage[]; tools?: ToolDef[]; responseSchema?: JsonSchema;
              temperature?: number; maxOutputTokens?: number; signal?: AbortSignal }): Promise<LlmResponse>;
  stream(req: …): AsyncIterable<LlmStreamEvent>;
}
```
Adapter: `OpenAiProvider` (SDK `openai`), `GeminiProvider` (SDK `@google/genai`). Chỉ một adapter được hiện thực trong MVP (D-08). API key ở server, không bao giờ tới frontend; LLM không có credential DB – nó chỉ nhận JSON từ tool.

### 9.5 Đánh giá chất lượng
Bộ eval cố định (≥ 50 câu hỏi tiếng Việt/Anh trên dataset mẫu) với IR kỳ vọng → chạy trong CI (tùy chọn, khi có API key) đo tỉ lệ IR khớp chính xác. Đây là thước đo "AI accuracy" thay vì cảm tính.

---

## 10. API dự kiến (chi tiết trong API_DOCUMENTATION.md ở Phase 4)

```
GET/POST   /semantic-models
GET/PATCH  /semantic-models/:id            POST /semantic-models/:id/publish | /validate
CRUD       /semantic-models/:id/entities | /dimensions | /measures | /relationships | /access-policies
CRUD       /metrics          POST /metrics/:id/versions   POST /metrics/:id/versions/:v/publish
POST       /semantic-query            (IR → kết quả; dùng bởi KPI card, dashboard, AI)
POST       /semantic-query/compile    (IR → SQL, không chạy; cho màn hình "test metric")
GET        /catalog                   (member đã lọc theo quyền)
```
