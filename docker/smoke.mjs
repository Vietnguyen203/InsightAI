// Post-deployment smoke test through the public edge (Caddy → API → worker → PostgreSQL/S3).
// Creates a throwaway account and organization; run against staging or right after a deploy:
//   node docker/smoke.mjs https://analytics.example.vn
// Exits non-zero on the first failure. Uses no credentials of its own.

const base = (process.argv[2] ?? 'http://localhost:18080').replace(/\/$/, '');
const suffix = Math.random().toString(36).slice(2, 10);
let token = null;
let org = null;

async function call(method, path, body, { expect = 200, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status !== expect) {
    throw new Error(
      `${method} ${path}: expected ${expect}, got ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

function step(name) {
  process.stdout.write(`• ${name} … `);
}
const ok = () => console.log('ok');

try {
  step('health (live, ready)');
  await call('GET', '/health/live');
  const ready = await call('GET', '/health/ready');
  if (ready.status !== 'ok') throw new Error(`not ready: ${JSON.stringify(ready)}`);
  ok();

  step('security headers and SPA');
  const page = await fetch(`${base}/datasets`);
  const html = await page.text();
  if (!html.includes('<div id="root">')) throw new Error('SPA fallback does not serve index.html');
  if (page.headers.get('x-content-type-options') !== 'nosniff') throw new Error('missing headers');
  ok();

  step('register (creates organization and tenant schema)');
  const auth = await call(
    'POST',
    '/api/v1/auth/register',
    {
      email: `smoke-${suffix}@smoke.insightai.local`,
      password: `smoke-${suffix}-${suffix}`,
      fullName: 'Smoke Test',
      organizationName: `Smoke ${suffix}`,
    },
    { expect: 201 },
  );
  token = auth.accessToken;
  const me = await call('GET', '/api/v1/auth/me');
  org = me.memberships[0].organizationId;
  ok();

  step('upload CSV and import in the worker');
  const dataset = await call('POST', '/api/v1/datasets', { name: 'smoke' }, { expect: 201 });
  const form = new FormData();
  form.append('file', new Blob(['id,amount\n1,10\n2,32\n']), 'smoke.csv');
  form.append('options', JSON.stringify({ locale: 'en' }));
  const job = await call('POST', `/api/v1/datasets/${dataset.id}/imports`, form, { expect: 202 });
  let status = job.status;
  for (let i = 0; i < 60 && status !== 'SUCCEEDED'; i++) {
    if (status === 'FAILED') throw new Error('import failed');
    await new Promise((r) => setTimeout(r, 1000));
    status = (await call('GET', `/api/v1/imports/${job.id}`)).status;
  }
  if (status !== 'SUCCEEDED') throw new Error(`import still ${status}`);
  ok();

  step('AI status and organization data-sharing default');
  await call('GET', '/api/v1/ai/status');
  const current = await call('GET', '/api/v1/organizations/current');
  if (current.aiDataSharing !== 'METADATA_ONLY') throw new Error('AI data sharing is not OFF');
  ok();

  console.log(`\nSmoke test passed against ${base} (organization "Smoke ${suffix}").`);
} catch (error) {
  console.log('FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
