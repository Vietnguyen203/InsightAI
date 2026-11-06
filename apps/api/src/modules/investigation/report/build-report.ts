import type {
  Evidence,
  Finding,
  HypothesisResult,
  InvestigationReport,
  InvestigationStatus,
  ReportParagraph,
} from '@insightai/contracts';
import { z } from 'zod';
import { chartFor, type Lang } from '../../ai/answer-text';
import {
  evidenceSegment,
  findingSegment,
  findingText,
  formatFigure,
  HYPOTHESIS_LABELS,
  limitationText,
  type PlaceholderResolver,
  renderGuarded,
} from './report-text';

export interface ReportInput {
  investigationId: string;
  goal: string;
  status: InvestigationStatus;
  errorCode: string | null;
  steps: { stepKey: string; purpose: string; status: string; errorCode: string | null }[];
  evidence: Evidence[];
  /** Most important first. */
  findings: Finding[];
  hypotheses: HypothesisResult[];
}

/** What the LLM may return (validated, then every text goes through the guard). */
export const reportDraftSchema = z.strictObject({
  summary: z.string().max(2000),
  findings: z
    .array(z.strictObject({ finding: z.string().max(10), text: z.string().max(2000) }))
    .max(20)
    .default([]),
  recommendations: z
    .array(
      z.strictObject({
        text: z.string().max(2000),
        findings: z.array(z.string().max(10)).min(1).max(5),
      }),
    )
    .max(10)
    .default([]),
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;

export const MAX_LENGTH = { summary: 800, finding: 500, recommendation: 400 } as const;
export const MAX_RECOMMENDATIONS = 3;
/** Findings described to the LLM (the rest keep their template sentence). */
export const MAX_PROMPT_FINDINGS = 10;

/** Short ids for the prompt: `f1…` by importance, `e1…` in the order the steps ran. */
export function aliases(input: ReportInput) {
  const findings = new Map(input.findings.map((f, i) => [`f${i + 1}`, f]));
  const evidence = new Map(input.evidence.map((e, i) => [`e${i + 1}`, e]));
  const evidenceAlias = new Map(input.evidence.map((e, i) => [e.id, `e${i + 1}`]));
  return { findings, evidence, evidenceAlias };
}

const evidenceOf = (input: ReportInput, finding: Finding) =>
  input.evidence.find((e) => e.id === finding.evidenceIds[0]);

/**
 * What the LLM is told: the goal, the hypotheses and, per finding and evidence, the names of the
 * figures it may reference. With METADATA_ONLY it never sees a value (members and figures are
 * data); with FULL it also gets the formatted values to choose wording.
 */
export function promptContext(input: ReportInput, lang: Lang, withValues: boolean) {
  const ids = aliases(input);
  return {
    language: lang === 'vi' ? 'Vietnamese' : 'English',
    status: input.status,
    hypotheses: input.hypotheses.map((h) => ({
      key: h.key,
      statement: h.statement,
      status: h.status,
    })),
    findings: [...ids.findings].slice(0, MAX_PROMPT_FINDINGS).flatMap(([alias, f]) => {
      const evidence = evidenceOf(input, f);
      if (!evidence) return [];
      const metric = typeof f.params.metric === 'string' ? f.params.metric : null;
      const params = Object.keys(f.params).filter((p) => p !== 'evidenceId');
      return [
        {
          id: alias,
          meaning: f.templateKey,
          evidence: ids.evidenceAlias.get(evidence.id),
          verified: f.verified,
          limitations: f.limitations,
          ...(metric ? { metric: formatFigure('metric', metric, evidence, null, lang) } : {}),
          params: withValues
            ? Object.fromEntries(
                params.map((p) => [p, findingSegment(f, evidence, p, lang)?.text ?? null]),
              )
            : params,
        },
      ];
    }),
    evidence: [...ids.evidence].map(([alias, e]) => ({
      id: alias,
      kind: e.kind,
      values: withValues
        ? Object.fromEntries(
            Object.keys(e.values).map((name) => [name, evidenceSegment(e, name, lang)?.text]),
          )
        : Object.keys(e.values),
    })),
  };
}

/**
 * The report: deterministic sentences, charts, hypotheses and limitations, with the LLM's wording
 * where it passed the guard. A draft that is null or entirely rejected gives a fully
 * deterministic report.
 */
export function buildReport(
  input: ReportInput,
  draft: ReportDraft | null,
  lang: Lang,
  now = new Date(),
): InvestigationReport {
  const vi = lang === 'vi';
  const ids = aliases(input);
  const resolve: PlaceholderResolver = (kind, alias, name) => {
    if (kind === 'ev') {
      const evidence = ids.evidence.get(alias);
      return evidence ? evidenceSegment(evidence, name, lang) : undefined;
    }
    const finding = ids.findings.get(alias);
    const evidence = finding && evidenceOf(input, finding);
    return finding && evidence ? findingSegment(finding, evidence, name, lang) : undefined;
  };
  const llmText = (text: string | undefined, max: number): ReportParagraph | null => {
    const segments = text === undefined ? null : renderGuarded(text, max, resolve);
    return segments ? { source: 'llm', segments } : null;
  };

  const drafted = new Map<string, string>();
  for (const f of draft?.findings ?? [])
    if (!drafted.has(f.finding)) drafted.set(f.finding, f.text);

  const entries = [...ids.findings].flatMap(([alias, f]) => {
    const evidence = evidenceOf(input, f);
    return evidence ? [{ alias, f, evidence, template: findingText(f, evidence, lang) }] : [];
  });
  const findings = entries.map(({ alias, f, evidence, template }) => {
    const result = evidence.results[0];
    return {
      findingId: f.id,
      kind: f.kind,
      templateKey: f.templateKey,
      verified: f.verified,
      importance: f.importance,
      evidenceIds: f.evidenceIds,
      // Unverified findings keep the template, which says so.
      text: (f.verified ? llmText(drafted.get(alias), MAX_LENGTH.finding) : null) ?? template,
      chart: result ? { evidenceId: evidence.id, resultIndex: 0, spec: chartFor(result) } : null,
      limitations: f.limitations,
    };
  });

  const top = entries[0];
  const summary: ReportParagraph = llmText(draft?.summary, MAX_LENGTH.summary) ?? {
    source: 'template',
    segments: top
      ? [
          { type: 'text', text: vi ? 'Phát hiện chính: ' : 'Main finding: ' },
          ...top.template.segments,
        ]
      : [
          {
            type: 'text',
            text: vi
              ? 'Không tìm thấy phát hiện nào đủ bằng chứng.'
              : 'No finding is backed by enough evidence.',
          },
        ],
  };

  const recommendations = (draft?.recommendations ?? []).flatMap((r) => {
    const findingIds = [...new Set(r.findings)].map((a) => ids.findings.get(a)?.id);
    if (findingIds.length === 0 || findingIds.some((id) => !id)) return [];
    const text = llmText(r.text, MAX_LENGTH.recommendation);
    return text ? [{ text, findingIds: findingIds as string[] }] : [];
  });

  const used =
    summary.source === 'llm' ||
    findings.some((f) => f.text.source === 'llm') ||
    recommendations.length > 0;

  return {
    investigationId: input.investigationId,
    lang,
    renderer: used ? 'llm' : 'deterministic',
    status: input.status,
    goal: input.goal,
    summary,
    findings,
    hypotheses: input.hypotheses.map((h) => ({
      key: h.key,
      statement: h.statement,
      status: h.status,
      label: HYPOTHESIS_LABELS[h.status][vi ? 0 : 1],
      evidenceIds: h.evidenceIds,
    })),
    recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS),
    limitations: limitations(input, lang),
    createdAt: now.toISOString(),
  };
}

/** From the run's status, the steps that did not run, evidence limitations and data quality. */
export function limitations(input: ReportInput, lang: Lang): InvestigationReport['limitations'] {
  const vi = lang === 'vi';
  const out: InvestigationReport['limitations'] = [];
  if (input.status === 'PARTIAL') {
    const code = input.errorCode ?? 'STEPS_INCOMPLETE';
    out.push({
      code: 'PARTIAL_RUN',
      text: vi
        ? `Điều tra dừng trước khi hoàn tất (${code}); báo cáo chỉ dựa trên các bước đã chạy.`
        : `The investigation stopped before finishing (${code}); the report covers the steps that ran.`,
      evidenceIds: [],
    });
  }
  for (const step of input.steps) {
    if (step.status !== 'FAILED' && step.status !== 'SKIPPED') continue;
    const code = step.errorCode ?? step.status;
    out.push({
      code: `STEP_${step.status}`,
      text:
        step.status === 'FAILED'
          ? vi
            ? `Bước “${step.purpose}” không chạy được (${code}).`
            : `Step “${step.purpose}” could not run (${code}).`
          : vi
            ? `Bước “${step.purpose}” bị bỏ qua (${code}).`
            : `Step “${step.purpose}” was skipped (${code}).`,
      evidenceIds: [],
    });
  }

  const byCode = new Map<string, string[]>();
  for (const e of input.evidence) {
    for (const code of e.limitations) byCode.set(code, [...(byCode.get(code) ?? []), e.id]);
  }
  for (const [code, evidenceIds] of byCode) {
    out.push({ code, text: limitationText(code, lang), evidenceIds });
  }

  const datasets = new Map<string, { name: string; versionNo: number; score: number | null }>();
  const datasetEvidence = new Map<string, string[]>();
  for (const e of input.evidence) {
    for (const d of e.versions.datasets) {
      const key = `${d.id}:${d.versionNo}`;
      datasets.set(key, { name: d.name, versionNo: d.versionNo, score: d.qualityScore });
      datasetEvidence.set(key, [...(datasetEvidence.get(key) ?? []), e.id]);
    }
  }
  for (const [key, d] of datasets) {
    const score =
      d.score === null
        ? vi
          ? 'chưa có điểm chất lượng'
          : 'no quality score yet'
        : `${vi ? 'điểm chất lượng' : 'quality score'} ${Math.round(d.score)}/100`;
    out.push({
      code: 'DATA_QUALITY',
      text: vi
        ? `Bộ dữ liệu “${d.name}” (phiên bản ${d.versionNo}): ${score}.`
        : `Dataset “${d.name}” (version ${d.versionNo}): ${score}.`,
      evidenceIds: datasetEvidence.get(key)!,
    });
  }
  return out;
}
