// Seeds the k6 performance scenario (Phase 6H-2) through the public API: a new organization with
// 2,000,000 orders and 5,000 customers, a published model with metrics, and a dashboard with
// 10 widgets. Writes the connection details to k6/.perf-seed.json (git-ignored) for k6/load.mjs.
//
//   PERF_API_URL=http://localhost:3300/api/v1 node k6/seed.mjs
//
// The account uses the integration-test e-mail domain, so `pnpm test:int` removes it (and its
// tenant schema) on its next run. Rows are generated from a fixed seed (reproducible).
import { randomBytes } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const API = process.env.PERF_API_URL ?? 'http://localhost:3300/api/v1';
const ORDERS = Number(process.env.PERF_ROWS ?? 2_000_000);
const CUSTOMERS = 5_000;
const OUT = new URL('./.perf-seed.json', import.meta.url);

const REGIONS = ['Miền Bắc', 'Miền Trung', 'Miền Nam'];
const CITIES = [
  ['Hà Nội', 0],
  ['Hải Phòng', 0],
  ['Quảng Ninh', 0],
  ['Đà Nẵng', 1],
  ['Huế', 1],
  ['Nha Trang', 1],
  ['TP.HCM', 2],
  ['Cần Thơ', 2],
  ['Biên Hòa', 2],
  ['Vũng Tàu', 2],
];
const CHANNELS = ['Online', 'Store', 'Partner'];
const START = Date.UTC(2025, 0, 1);
const DAYS = 669; // 2025-01-01 … 2026-10-31

let state = 42;
const rand = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};

async function writeCsv(path, header, rows) {
  const out = createWriteStream(path);
  out.write(`${header}\n`);
  let buffer = '';
  for (const line of rows) {
    buffer += `${line}\n`;
    if (buffer.length > 1 << 20) {
      if (!out.write(buffer)) await once(out, 'drain');
      buffer = '';
    }
  }
  out.end(buffer);
  await once(out, 'finish');
}

function* customerRows() {
  for (let id = 1; id <= CUSTOMERS; id++) {
    const [city, region] = CITIES[Math.floor(rand() * CITIES.length)];
    yield `${id},${city},${REGIONS[region]}`;
  }
}

function* orderRows() {
  for (let id = 1; id <= ORDERS; id++) {
    const day = Math.floor((id - 1) / (ORDERS / DAYS));
    const date = new Date(START + Math.min(day, DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const customer = 1 + Math.floor(rand() * CUSTOMERS);
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)];
    const status = rand() < 0.92 ? 'PAID' : 'CANCELLED';
    const amount = (50 + rand() * 950).toFixed(2);
    yield `${id},${date},${customer},${channel},${status},${amount}`;
  }
}

let token = '';
let org = '';
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
      ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path, body = {}) => call('POST', path, body);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importCsv(name, file) {
  const dataset = await post('/datasets', { name });
  const form = new FormData();
  form.append('file', await openAsBlob(file), `${name}.csv`);
  form.append('options', JSON.stringify({ locale: 'en' }));
  const started = Date.now();
  const job = await post(`/datasets/${dataset.id}/imports`, form);
  for (;;) {
    const current = await call('GET', `/imports/${job.id}`);
    if (current.status === 'SUCCEEDED') break;
    if (current.status === 'FAILED')
      throw new Error(`import ${name}: ${JSON.stringify(current.error)}`);
    await sleep(2_000);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`imported ${name} (${(await stat(file)).size} bytes) in ${seconds} s`);
  return dataset.id;
}

/** Same rule as the Ask feature (apps/api/src/modules/ai/answer-text.ts chartFor). */
function chartFor(result) {
  const time = result.columns.find((c) => c.kind === 'time');
  const dims = result.columns.filter((c) => c.kind === 'dimension');
  const series = result.columns
    .filter((c) => (c.kind === 'metric' || c.kind === 'measure') && !c.comparison)
    .filter((c) => c.type === 'INTEGER' || c.type === 'DECIMAL')
    .map((c) => c.key);
  if (series.length === 0) return { type: 'table', x: null, series: [] };
  if (!time && dims.length === 0) return { type: 'kpi', x: null, series };
  if (time && dims.length === 0) return { type: 'line', x: time.key, series };
  if (!time && dims.length === 1 && result.rows.length <= 50)
    return { type: 'bar', x: dims[0].key, series };
  return { type: 'table', x: null, series };
}

const OCT = { from: '2026-10-01', to: '2026-10-31' };
const LAST_YEAR = { from: '2025-11-01', to: '2026-10-31' };
const WIDGETS = [
  ['Doanh thu', { metrics: ['paid_revenue'] }],
  ['Số đơn', { metrics: ['paid_orders'] }],
  ['Giá trị đơn trung bình', { metrics: ['aov'] }],
  [
    'Doanh thu tháng 10 so với tháng 9',
    { metrics: ['paid_revenue'], timeDimension: { dateRange: OCT }, compareTo: 'previous_period' },
  ],
  [
    'Doanh thu theo tháng',
    { metrics: ['paid_revenue'], timeDimension: { granularity: 'month', dateRange: LAST_YEAR } },
  ],
  [
    'Số đơn theo tuần',
    {
      metrics: ['paid_orders'],
      timeDimension: { granularity: 'week', dateRange: { from: '2026-08-01', to: '2026-10-31' } },
    },
  ],
  ['Doanh thu theo miền', { metrics: ['paid_revenue'], dimensions: ['customer.region'] }],
  ['Số đơn theo kênh', { metrics: ['paid_orders'], dimensions: ['order.channel'] }],
  ['Giá trị đơn theo miền', { metrics: ['aov'], dimensions: ['customer.region'] }],
  [
    'Doanh thu theo thành phố',
    {
      metrics: ['paid_revenue', 'paid_orders'],
      dimensions: ['customer.city'],
      orderBy: [{ member: 'paid_revenue', dir: 'desc' }],
    },
  ],
];

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'insightai-k6-'));
  try {
    const customers = join(dir, 'customers.csv');
    const orders = join(dir, 'orders.csv');
    await writeCsv(customers, 'customer_id,city,region', customerRows());
    await writeCsv(orders, 'order_id,created_at,customer_id,channel,status,amount', orderRows());
    console.log(`generated ${ORDERS} orders`);

    const email = `perf-${Date.now()}@int-test.insightai.local`;
    const password = randomBytes(18).toString('base64url');
    const registered = await post('/auth/register', {
      email,
      password,
      fullName: 'Perf Owner',
      organizationName: 'Perf Org',
    });
    token = registered.accessToken;
    org = (await call('GET', '/auth/me')).memberships[0].organizationId;

    const datasets = {
      customers: await importCsv('customers', customers),
      orders: await importCsv('orders', orders),
    };

    let model = await post('/semantic-models', { key: 'sales', name: 'Sales' });
    for (const [key, dataset, pk] of [
      ['order', 'orders', 'order_id'],
      ['customer', 'customers', 'customer_id'],
    ]) {
      model = await post(`/semantic-models/${model.id}/entities`, {
        key,
        name: key,
        datasetId: datasets[dataset],
        primaryKey: [pk],
      });
    }
    const entity = (key) => model.entities.find((x) => x.key === key).id;
    for (const [owner, key, type, expr] of [
      ['order', 'order_date', 'TIME', 'created_at'],
      ['order', 'status', 'CATEGORICAL', 'status'],
      ['order', 'channel', 'CATEGORICAL', 'channel'],
      ['customer', 'city', 'CATEGORICAL', 'city'],
      ['customer', 'region', 'CATEGORICAL', 'region'],
    ]) {
      await post(`/semantic-entities/${entity(owner)}/dimensions`, { key, name: key, type, expr });
    }
    await post(`/semantic-entities/${entity('order')}/measures`, {
      key: 'revenue',
      name: 'revenue',
      agg: 'sum',
      expr: 'amount',
    });
    await post(`/semantic-entities/${entity('order')}/measures`, {
      key: 'orders',
      name: 'orders',
      agg: 'count',
    });
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: entity('order'),
      toEntityId: entity('customer'),
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    });
    await post(`/semantic-models/${model.id}/publish`);

    const paid = [{ member: 'order.status', op: 'eq', values: ['PAID'] }];
    const simple = (measure) => ({
      type: 'SIMPLE',
      measure,
      filters: paid,
      timeDimension: 'order.order_date',
    });
    for (const [key, label, format, definition] of [
      ['paid_revenue', 'Doanh thu', 'currency', simple('order.revenue')],
      ['paid_orders', 'Số đơn', 'number', simple('order.orders')],
      [
        'aov',
        'Giá trị đơn trung bình',
        'currency',
        { type: 'RATIO', numerator: 'paid_revenue', denominator: 'paid_orders' },
      ],
    ]) {
      const metric = await post(`/semantic-models/${model.id}/metrics`, {
        key,
        label,
        format,
        definition,
      });
      await post(`/metric-versions/${metric.draft.id}/publish`);
    }

    const dashboard = await post('/dashboards', { name: 'Perf – 10 widgets', visibility: 'ORG' });
    for (const [i, [title, ir]] of WIDGETS.entries()) {
      const query = { model: 'sales', ...ir };
      const result = await post('/semantic-query', query);
      await post(`/dashboards/${dashboard.id}/widgets`, {
        title,
        query,
        chart: chartFor(result),
        position: { x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 },
      });
    }

    await writeFile(
      OUT,
      `${JSON.stringify({ apiUrl: API, email, password, organizationId: org, dashboardId: dashboard.id, rows: ORDERS }, null, 2)}\n`,
    );
    console.log(`seed written to ${OUT.pathname}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
