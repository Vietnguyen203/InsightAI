// k6 load test (Phase 6H-2, acceptance in docs/PHASE6_AUDIT.md §6 "6E"): 20 virtual users against
// the 2,000,000-row organization created by k6/seed.mjs.
//
//   k6 run k6/load.mjs            (reads k6/.perf-seed.json; DURATION=3m by default)
//
// Scenarios (run in parallel, 20 VUs in total):
//   cache_miss – semantic queries with a random date range, so the Redis result cache never hits
//   cache_hit  – one fixed semantic query (warmed in setup)
//   dashboard  – open a 10-widget dashboard: detail + all widgets run in parallel, as the web app does
//
//   COLD=1 k6 run k6/load.mjs    (cold dashboard: run when the widgets' cached results have expired,
//                                 i.e. > 10 min after the last dashboard run; 4 users open it at once
//                                 while 8 users send cache-miss queries; fails if any widget was cached)
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const seed = JSON.parse(open('./.perf-seed.json'));
const API = __ENV.PERF_API_URL || seed.apiUrl;
const DURATION = __ENV.DURATION || '3m';
const COLD = __ENV.COLD === '1';

const dashboardLoad = new Trend('dashboard_load', true);
/** Dashboard loads where no widget came from the result cache (first open after expiry/new data). */
const dashboardLoadCold = new Trend('dashboard_load_cold', true);
const dashboardColdLoads = new Counter('dashboard_cold_loads');
/** Single widget runs computed by the database (not from the cache). */
const widgetRunCold = new Trend('widget_run_cold', true);
const cacheHits = new Rate('cache_hits');

const common = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
  'http_req_duration{scenario:cache_miss}': ['p(95)<3000'],
  'cache_hits{scenario:cache_miss}': ['rate<0.05'],
};

export const options = COLD
  ? {
      scenarios: {
        cache_miss: { executor: 'constant-vus', vus: 8, duration: '1m', exec: 'cacheMiss' },
        dashboard: {
          executor: 'per-vu-iterations',
          vus: 4,
          iterations: 1,
          startTime: '10s',
          exec: 'dashboard',
        },
      },
      thresholds: {
        ...common,
        dashboard_load_cold: ['max<5000'],
        dashboard_cold_loads: ['count==4'],
      },
      summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    }
  : {
      scenarios: {
        cache_miss: { executor: 'constant-vus', vus: 8, duration: DURATION, exec: 'cacheMiss' },
        cache_hit: { executor: 'constant-vus', vus: 8, duration: DURATION, exec: 'cacheHit' },
        dashboard: { executor: 'constant-vus', vus: 4, duration: DURATION, exec: 'dashboard' },
      },
      thresholds: {
        ...common,
        'http_req_duration{scenario:cache_hit}': ['p(95)<300'],
        'cache_hits{scenario:cache_hit}': ['rate>0.95'],
        dashboard_load: ['p(95)<5000'],
      },
      summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    };

const HIT_QUERY = {
  model: 'sales',
  metrics: ['paid_revenue', 'paid_orders'],
  dimensions: ['customer.region'],
  timeDimension: { dateRange: { from: '2026-01-01', to: '2026-06-30' } },
};

const SHAPES = [
  (range) => ({ metrics: ['paid_revenue'], timeDimension: { dateRange: range } }),
  (range) => ({
    metrics: ['paid_revenue', 'paid_orders'],
    dimensions: ['customer.region'],
    timeDimension: { dateRange: range },
  }),
  (range) => ({
    metrics: ['aov'],
    dimensions: ['order.channel'],
    timeDimension: { dateRange: range },
  }),
  (range) => ({
    metrics: ['paid_revenue'],
    timeDimension: { granularity: 'week', dateRange: range },
  }),
  (range) => ({
    metrics: ['paid_orders'],
    dimensions: ['customer.city'],
    timeDimension: { dateRange: range },
    orderBy: [{ member: 'paid_orders', dir: 'desc' }],
  }),
];

const DAY = 86_400_000;
const FIRST_DAY = Date.UTC(2025, 0, 1);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAYS = 669; // the seed's orders cover 2025-01-01 … 2026-10-31
/** A random range of 1 week up to the whole history (the longest ones scan all 2,000,000 rows). */
function randomRange() {
  const length = 7 + Math.floor(Math.random() * (DAYS - 7));
  const start = FIRST_DAY + Math.floor(Math.random() * (DAYS - length + 1)) * DAY;
  return { from: iso(start), to: iso(start + (length - 1) * DAY) };
}

export function setup() {
  const login = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: seed.email, password: seed.password }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (login.status !== 200 && login.status !== 201) fail(`login: ${login.status} ${login.body}`);
  const headers = {
    authorization: `Bearer ${login.json('accessToken')}`,
    'x-organization-id': seed.organizationId,
    'content-type': 'application/json',
  };
  const warm = http.post(`${API}/semantic-query`, JSON.stringify(HIT_QUERY), { headers });
  if (warm.status !== 200 && warm.status !== 201) fail(`warm-up: ${warm.status} ${warm.body}`);
  const detail = http.get(`${API}/dashboards/${seed.dashboardId}`, { headers });
  if (detail.status !== 200) fail(`dashboard: ${detail.status} ${detail.body}`);
  return { headers, widgets: detail.json('widgets').map((w) => w.id) };
}

function query(headers, ir) {
  const res = http.post(`${API}/semantic-query`, JSON.stringify(ir), { headers });
  const ok = check(res, { 'query 2xx': (r) => r.status === 200 || r.status === 201 });
  if (ok) cacheHits.add(res.json('cached') === true);
}

export function cacheMiss({ headers }) {
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  query(headers, { model: 'sales', ...shape(randomRange()) });
  sleep(0.5 + Math.random());
}

export function cacheHit({ headers }) {
  query(headers, HIT_QUERY);
  sleep(0.5 + Math.random());
}

export function dashboard({ headers, widgets }) {
  const started = Date.now();
  const detail = http.get(`${API}/dashboards/${seed.dashboardId}`, { headers });
  check(detail, { 'dashboard 200': (r) => r.status === 200 });
  const runs = http.batch(
    widgets.map((id) => ['POST', `${API}/dashboard-widgets/${id}/run`, '{}', { headers }]),
  );
  const elapsed = Date.now() - started;
  dashboardLoad.add(elapsed);
  const ok = check(runs, {
    'all widgets 2xx': (all) => all.every((r) => r.status === 200 || r.status === 201),
  });
  if (!ok) return;
  for (const r of runs) if (r.json('cached') === false) widgetRunCold.add(r.timings.duration);
  if (runs.every((r) => r.json('cached') === false)) {
    dashboardLoadCold.add(elapsed);
    dashboardColdLoads.add(1);
  }
  sleep(2 + Math.random() * 2);
}
