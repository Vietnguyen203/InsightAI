// Stand-in for the OpenAI Chat Completions API in end-to-end tests (OPENAI_BASE_URL points
// here). It answers like a well-behaved model for the E2E fixture: a semantic query for
// questions, an analysis plan for investigations, a narrative with placeholders for reports.
// It never sees credentials and keeps nothing.
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 18080);
const OCT = { from: '2026-10-01', to: '2026-10-31' };
const SEP = { from: '2026-09-01', to: '2026-09-30' };

const PLAN = {
  version: 1,
  goal: 'Explain the change of paid revenue',
  primaryMetric: 'paid_revenue',
  hypotheses: [
    {
      id: 'h1',
      statement: 'One region drives most of the change',
      expectation: { kind: 'member_drives_change', stepId: 's2' },
    },
  ],
  steps: [
    {
      id: 's1',
      tool: 'compare_periods',
      purpose: 'Overall change of paid revenue',
      metrics: ['paid_revenue'],
      current: OCT,
      baseline: SEP,
    },
    {
      id: 's2',
      tool: 'contribution',
      purpose: 'Which regions drive the change',
      metric: 'paid_revenue',
      dimension: 'customer.region',
      current: OCT,
      baseline: SEP,
    },
  ],
};

const REPORT = {
  summary:
    'Paid revenue changed by {{ev:e1.paid_revenue.delta}} ({{ev:e1.paid_revenue.deltaRatio}}); {{finding:f1.member}} contributed most.',
  findings: [
    {
      finding: 'f1',
      text: '{{finding:f1.member}} accounts for {{finding:f1.share}} of the change.',
    },
  ],
  recommendations: [
    { text: 'Review the sales channels in {{finding:f1.member}}.', findings: ['f1'] },
  ],
};

const QUERY = { metrics: ['paid_revenue'], dimensions: ['customer.region'] };

function reply(body) {
  const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
  const call = (name, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  });
  if (tools.has('propose_plan')) return call('propose_plan', PLAN);
  if (tools.has('write_report')) return call('write_report', REPORT);
  if (tools.has('run_semantic_query')) return call('run_semantic_query', QUERY);
  if (body.response_format?.type === 'json_object') {
    return { role: 'assistant', content: JSON.stringify({ narrative: 'Revenue by region.' }) };
  }
  return { role: 'assistant', content: 'OK' };
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let message;
    try {
      message = reply(JSON.parse(raw));
    } catch {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake OpenAI on :${PORT}`));
