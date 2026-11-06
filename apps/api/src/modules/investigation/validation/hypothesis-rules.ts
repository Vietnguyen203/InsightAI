import type { Hypothesis, HypothesisStatus } from '@insightai/contracts';
import type { ToolOutput } from '../analysis-tools.service';
import { normalizePhrase } from '../../semantic/semantic-metric.service';

/** Thresholds of the deterministic rules (docs/PHASE6_AI_ANALYST_DESIGN.md §2.7). */
export interface RuleThresholds {
  /** Share of the total change a member needs to "drive" it. */
  memberShare: number;
  /** Below this relative change of the total, a change is too small to explain. */
  minTotalChange: number;
  /** Relative change for "the metric changed". */
  metricChange: number;
  /** Goodness of fit for a trend to count. */
  trendR2: number;
}

export const DEFAULT_THRESHOLDS: RuleThresholds = {
  memberShare: 0.4,
  minTotalChange: 0.01,
  metricChange: 0.02,
  trendR2: 0.5,
};

export interface RuleResult {
  status: HypothesisStatus;
  rule: {
    name: string;
    /** Stable reason code (rendered in the report language by 6F). */
    reason: string;
    thresholds: Record<string, number>;
    observed: Record<string, string | number | null>;
  };
}

const result = (
  status: HypothesisStatus,
  name: string,
  reason: string,
  thresholds: Record<string, number>,
  observed: Record<string, string | number | null> = {},
): RuleResult => ({ status, rule: { name, reason, thresholds, observed } });

const same = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && normalizePhrase(a) === normalizePhrase(b);

/**
 * Evaluates one hypothesis against the output of the step it names. Never concludes causality:
 * SUPPORTED means "the evidence is consistent with it". A step that did not run is UNTESTED.
 */
export function evaluateHypothesis(
  hypothesis: Hypothesis,
  output: ToolOutput | null,
  t: RuleThresholds = DEFAULT_THRESHOLDS,
): RuleResult {
  const { kind, member, direction } = hypothesis.expectation;
  if (!output) return result('UNTESTED', kind, 'STEP_NOT_RUN', {});

  switch (kind) {
    case 'member_drives_change': {
      const th = { memberShare: t.memberShare, minTotalChange: t.minTotalChange };
      if (output.tool !== 'contribution') return result('UNTESTED', kind, 'WRONG_STEP', th);
      const members =
        output.kind === 'additive'
          ? output.contribution.members.map((m) => ({ member: m.member, share: m.share }))
          : output.decomposition.members.map((m) => ({
              member: m.member,
              share: output.decomposition.delta ? m.effect / output.decomposition.delta : null,
            }));
      const limitations =
        output.kind === 'additive'
          ? output.contribution.limitations
          : output.decomposition.limitations;
      const totalDelta =
        output.kind === 'additive'
          ? Number(output.contribution.totalDelta)
          : output.decomposition.delta;
      const base =
        output.kind === 'additive'
          ? Math.abs(Number(output.contribution.totalBaseline))
          : Math.abs(output.decomposition.ratioBaseline ?? 0);
      const relative = totalDelta !== null && base > 0 ? Math.abs(totalDelta) / base : null;
      const observed = {
        totalDelta: totalDelta ?? null,
        relativeChange: relative,
        members: members.length,
      };
      if (totalDelta === null || totalDelta === 0 || limitations.includes('ZERO_TOTAL')) {
        return result('INCONCLUSIVE', kind, 'NO_CHANGE', th, observed);
      }
      if (relative !== null && relative < t.minTotalChange) {
        return result('INCONCLUSIVE', kind, 'CHANGE_TOO_SMALL', th, observed);
      }
      if (members.length < 2) return result('INCONCLUSIVE', kind, 'TOO_FEW_MEMBERS', th, observed);
      if (direction && (direction === 'up') !== totalDelta > 0) {
        return result('NOT_SUPPORTED', kind, 'DIRECTION_DIFFERS', th, observed);
      }
      const candidate = member
        ? members.find((m) => same(m.member, member))
        : [...members].sort((a, b) => (b.share ?? -Infinity) - (a.share ?? -Infinity))[0];
      if (!candidate) {
        // A row filter may hide the member from this user: absence proves nothing then.
        return limitations.includes('POLICY_FILTERED') || limitations.includes('TRUNCATED')
          ? result('INCONCLUSIVE', kind, 'MEMBER_NOT_VISIBLE', th, observed)
          : result('NOT_SUPPORTED', kind, 'MEMBER_ABSENT', th, observed);
      }
      const seen = { ...observed, member: candidate.member, share: candidate.share };
      if (candidate.share !== null && candidate.share >= t.memberShare) {
        return result('SUPPORTED', kind, 'MEMBER_SHARE_ABOVE', th, seen);
      }
      return result('NOT_SUPPORTED', kind, 'MEMBER_SHARE_BELOW', th, seen);
    }

    case 'metric_changed': {
      const th = { metricChange: t.metricChange };
      if (output.tool !== 'compare_periods') return result('UNTESTED', kind, 'WRONG_STEP', th);
      const c = output.comparisons[0];
      if (!c || c.deltaRatio === null) {
        return result('INCONCLUSIVE', kind, c?.current === null ? 'NO_DATA' : 'ZERO_BASELINE', th);
      }
      const observed = { delta: c.delta, deltaRatio: c.deltaRatio, direction: c.direction };
      if (Math.abs(c.deltaRatio) < t.metricChange) {
        return result('NOT_SUPPORTED', kind, 'CHANGE_BELOW', th, observed);
      }
      if (direction && direction !== c.direction) {
        return result('NOT_SUPPORTED', kind, 'DIRECTION_DIFFERS', th, observed);
      }
      return result('SUPPORTED', kind, 'CHANGE_ABOVE', th, observed);
    }

    case 'trend_direction': {
      const th = { trendR2: t.trendR2 };
      if (output.tool !== 'trend') return result('UNTESTED', kind, 'WRONG_STEP', th);
      const tr = output.trends[0];
      if (!tr || tr.slope === null || tr.r2 === null) {
        return result('INCONCLUSIVE', kind, 'TOO_FEW_POINTS', th, { points: tr?.fitted ?? 0 });
      }
      const observed = { slope: tr.slope, r2: tr.r2, direction: tr.direction, points: tr.fitted };
      // A flat line is evidence against a trend, whatever its fit (flat series fit poorly).
      if (tr.direction === 'flat') return result('NOT_SUPPORTED', kind, 'FLAT', th, observed);
      if (tr.r2 < t.trendR2) return result('INCONCLUSIVE', kind, 'WEAK_FIT', th, observed);
      if (direction && direction !== tr.direction) {
        return result('NOT_SUPPORTED', kind, 'DIRECTION_DIFFERS', th, observed);
      }
      return result('SUPPORTED', kind, 'TREND_FITS', th, observed);
    }

    case 'anomaly_present': {
      const th = {};
      if (output.tool !== 'anomaly') return result('UNTESTED', kind, 'WRONG_STEP', th);
      const reports = member
        ? output.reports.filter((r) => same(r.member, member))
        : output.reports;
      const usable = reports.filter((r) => !r.limitations.includes('LOW_SAMPLE'));
      const count = reports.reduce((n, r) => n + r.anomalies.length, 0);
      const observed = { series: reports.length, anomalies: count };
      if (count > 0) return result('SUPPORTED', kind, 'ANOMALY_FOUND', th, observed);
      if (usable.length === 0) return result('INCONCLUSIVE', kind, 'TOO_FEW_POINTS', th, observed);
      return result('NOT_SUPPORTED', kind, 'NO_ANOMALY', th, observed);
    }
  }
}
