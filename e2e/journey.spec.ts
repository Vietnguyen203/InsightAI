import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

/**
 * The whole product journey through the UI (docs/PHASE6_AI_ANALYST_DESIGN.md §3, 6H):
 * register → upload → quality → semantic model + metric → ask → investigate → report →
 * pin to a dashboard → a viewer opens the dashboard. The model is a fake OpenAI endpoint.
 */

// Accounts use the integration-test domain, so the next `pnpm test:int` cleans them up.
const email = (label: string) =>
  `e2e-${label}-${randomBytes(4).toString('hex')}@int-test.insightai.local`;
const PASSWORD = 'correct horse battery staple';

/** Paid orders of September and October 2026 for two regions; North jumps in October. */
function ordersCsv() {
  const lines = ['order_id,customer_id,created_at,status,amount'];
  for (let d = 1; d <= 30; d++) {
    const dd = String(d).padStart(2, '0');
    lines.push(`S${d}a,C1,2026-09-${dd},PAID,${120 + (d % 4) * 2}`);
    lines.push(`S${d}b,C2,2026-09-${dd},PAID,${40 + (d % 3)}`);
    lines.push(`O${d}a,C1,2026-10-${dd},PAID,${180 + (d % 5) * 3}`);
    lines.push(`O${d}b,C2,2026-10-${dd},PAID,${45 + (d % 3) * 2}`);
  }
  return `${lines.join('\n')}\n`;
}
const CUSTOMERS = 'customer_id,region\nC1,North\nC2,South\n';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('insightai.language', 'en'));
});

async function register(page: Page, label: string, organization?: string) {
  const address = email(label);
  await page.goto('/register');
  await page.getByLabel('Full name').fill(`E2E ${label}`);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(PASSWORD);
  if (organization) await page.getByLabel('Organization name').fill(organization);
  await page.getByRole('button', { name: 'Create account' }).click();
  return address;
}

async function uploadDataset(page: Page, name: string, file: string, content: string) {
  await page.goto('/datasets');
  await page.getByRole('button', { name: 'New dataset' }).click();
  await page.getByLabel('Dataset name').fill(name);
  await page.getByRole('button', { name: 'New dataset' }).last().click();
  await page.getByLabel('File').setInputFiles({
    name: file,
    mimeType: 'text/csv',
    buffer: Buffer.from(content),
  });
  await page
    .getByLabel('Number & date format (CSV)')
    .selectOption({ label: 'International: 1,234.5 · MM/dd/yyyy' });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByRole('main').getByText('Ready', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

test('the whole journey, from sign-up to a viewer reading the dashboard', async ({
  page,
  browser,
}) => {
  await register(page, 'owner', 'E2E Company');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Datasets' }),
  ).toBeVisible();

  // ── Data ──
  await uploadDataset(page, 'orders', 'orders.csv', ordersCsv());
  await page.getByRole('tab', { name: 'Quality' }).click();
  await expect(page.getByText('Quality score')).toBeVisible({ timeout: 60_000 });
  await uploadDataset(page, 'customers', 'customers.csv', CUSTOMERS);

  // ── Semantic model + metric ──
  await page.goto('/semantic');
  await page.getByRole('button', { name: 'Create model' }).click();
  await page.getByLabel('Name').fill('Sales');
  await page.getByLabel('Key').fill('sales');
  await page.getByRole('button', { name: 'Create model' }).last().click();
  await addEntity(page, 'Order', 'order', 'orders', 'order_id');
  await addEntity(page, 'Customer', 'customer', 'customers', 'customer_id');
  await addMember(page, 'Order', 'dimension', {
    name: 'Order date',
    key: 'order_date',
    type: 'TIME',
    expr: 'created_at',
  });
  await addMember(page, 'Order', 'dimension', { name: 'Status', key: 'status', expr: 'status' });
  await addMember(page, 'Order', 'measure', {
    name: 'Revenue',
    key: 'revenue',
    agg: 'sum',
    expr: 'amount',
  });
  await addMember(page, 'Customer', 'dimension', { name: 'Region', key: 'region', expr: 'region' });
  await page.getByRole('button', { name: 'Add relationship' }).click();
  const rel = page.getByRole('form', { name: 'Add relationship' });
  await rel.getByLabel('From (many side)').selectOption({ label: 'Order' });
  await rel.getByLabel('Join column (from)').selectOption('customer_id');
  await rel.getByLabel('To (one side)').selectOption({ label: 'Customer' });
  await rel.getByLabel('Join column (to)').selectOption('customer_id');
  await rel.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published · r1/)).toBeVisible();

  await page.getByRole('tab', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const metric = page.getByRole('form', { name: /Create/ });
  await metric.getByLabel('Key').fill('paid_revenue');
  await metric.getByLabel('Label').fill('Paid revenue');
  await metric.getByLabel('Measure').selectOption('order.revenue');
  await metric.getByLabel('Default time dimension').selectOption('order.order_date');
  await metric.getByRole('button', { name: 'Add condition' }).click();
  await metric.getByLabel('Dimension', { exact: true }).selectOption('order.status');
  await metric.getByLabel('Value', { exact: true }).fill('PAID');
  await metric.getByRole('button', { name: /Create/ }).click();
  await page.getByRole('button', { name: 'Publish v1' }).click();
  await expect(page.getByText('v1 · Current')).toBeVisible();

  // ── Ask AI, pin the answer ──
  await page.goto('/ask');
  await page.getByRole('textbox', { name: 'Question' }).fill('Paid revenue by region?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByText('Understood as:')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Pin to dashboard' }).click();
  const pinAnswer = page.getByRole('form', { name: 'Pin to dashboard' });
  await pinAnswer.getByLabel('Dashboard name').fill('E2E board');
  await pinAnswer.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(page.getByText('Pinned to')).toBeVisible();

  // ── Investigate: live progress, report, evidence, pin a finding ──
  await page.goto('/investigations');
  await page.getByLabel('Problem to investigate').fill('Why did paid revenue change in October?');
  await page.getByRole('button', { name: 'Start investigation' }).click();
  const report = page.getByRole('article', { name: 'Report' });
  await expect(report).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await report.getByRole('button').filter({ hasText: /\d/ }).first().click();
  const evidence = page.getByRole('region', { name: 'Evidence' });
  await expect(evidence.getByRole('table').first()).toBeVisible();
  await report.getByRole('button', { name: 'Pin to dashboard' }).first().click();
  const pinFinding = report.getByRole('form', { name: 'Pin to dashboard' });
  await pinFinding
    .getByRole('combobox', { name: 'Dashboard' })
    .selectOption({ label: 'E2E board' });
  await pinFinding.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(report.getByText('Pinned to')).toBeVisible();

  // ── Share the dashboard with the organization ──
  await page.goto('/dashboards');
  await page.getByRole('link', { name: /E2E board/ }).click();
  await page.getByLabel('Who can see it').selectOption('ORG');
  await expect(page.getByText('Whole organization').first()).toBeVisible();
  const dashboardPath = new URL(page.url()).pathname;

  // ── A viewer joins and reads it ──
  await page.goto('/settings/members');
  await page.getByLabel('Role', { exact: true }).selectOption('viewer');
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = await page.locator('input[readonly]').first().inputValue();

  const viewerContext = await browser.newContext({ locale: 'en-US' });
  const viewer = await viewerContext.newPage();
  await viewer.addInitScript(() => localStorage.setItem('insightai.language', 'en'));
  await viewer.goto(new URL(link).pathname);
  await viewer.getByLabel('Full name').fill('E2E viewer');
  await viewer.getByLabel('Email').fill(email('viewer'));
  await viewer.getByLabel('Password').fill(PASSWORD);
  await viewer.getByRole('button', { name: /Create account|Join/ }).click();
  await expect(viewer.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await viewer.goto(dashboardPath);
  await expect(viewer.getByText('View only')).toBeVisible();
  const widgets = viewer.getByRole('list', { name: 'Widgets' }).getByRole('article');
  await expect(widgets).toHaveCount(2);
  // Both widgets run as the viewer and draw their chart.
  for (const widget of await widgets.all()) {
    await expect(widget.getByRole('img', { name: /Chart of/ })).toBeVisible({ timeout: 30_000 });
  }
  await expect(viewer.getByText(/not available to you/)).toHaveCount(0);
  await viewerContext.close();
});

async function addEntity(
  page: Page,
  name: string,
  key: string,
  dataset: string,
  primaryKey: string,
) {
  await page.getByRole('button', { name: 'Add entity' }).click();
  const form = page.getByRole('form', { name: 'Add entity' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Key').fill(key);
  await form.getByLabel('Dataset').selectOption({ label: dataset });
  await form.getByLabel(primaryKey, { exact: true }).check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name })).toBeVisible();
}

async function addMember(
  page: Page,
  entity: string,
  kind: 'dimension' | 'measure',
  m: { name: string; key: string; type?: 'TIME'; agg?: string; expr: string },
) {
  const section = page.getByRole('region', { name: entity });
  await section
    .getByRole('button', { name: kind === 'dimension' ? 'Add dimension' : 'Add measure' })
    .click();
  const form = section.getByRole('form', {
    name: kind === 'dimension' ? 'Add dimension' : 'Add measure',
  });
  await form.getByLabel('Name').fill(m.name);
  await form.getByLabel('Key').fill(m.key);
  if (m.type) await form.getByLabel('Type').selectOption(m.type);
  if (m.agg) await form.getByLabel('Aggregation').selectOption(m.agg);
  await form.getByLabel('Expression').fill(m.expr);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText(`${key(entity)}.${m.key}`, { exact: true })).toBeVisible();
}

const key = (entity: string) => entity.toLowerCase();
