import type { ToolOutput } from '../analysis-tools.service';
import type { EvidenceValue } from './evidence-values';

export interface DerivedFinding {
  kind: string;
  templateKey: string;
  params: Record<string, EvidenceValue>;
  evidenceIds: string[];
  verified: boolean;
  importance: number;
  limitations: string[];
}

/** Limitations that make a figure unreliable (it is still shown, with them). */
const WEAKENING = new Set(['NO_DATA', 'TOTAL_MISMATCH', 'TRUNCATED']);

const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const round = (x: number) => Number(x.toFixed(4));

/**
 * Findings derived only from a step's deterministic output, each tied to its evidence. The
 * importance (0…1) orders the report; it is computed, never chosen by the LLM.
 */
export function deriveFindings(
  output: ToolOutput,
  evidenceId: string,
  limitations: string[],
): DerivedFinding[] {
  const weak = limitations.filter((l) => WEAKENING.has(l));
  const finding = (
    kind: string,
    templateKey: string,
    params: Record<string, EvidenceValue>,
    importance: number,
  ): DerivedFinding => ({
    kind,
    templateKey,
    params: { evidenceId, ...params },
    evidenceIds: [evidenceId],
    verified: !weak.includes('NO_DATA'),
    importance: round(clamp(importance) * (weak.length > 0 ? 0.5 : 1)),
    limitations,
  });

  switch (output.tool) {
    case 'metric_snapshot':
      return [finding('snapshot', 'snapshot', { rows: output.result.rows.length }, 0.1)];

    case 'compare_periods':
      return output.comparisons
        .filter((c) => c.delta !== null)
        .map((c) =>
          finding(
            'metric_change',
            c.direction === 'flat' ? 'metric_change.flat' : `metric_change.${c.direction}`,
            { metric: c.metric, delta: c.delta, deltaRatio: c.deltaRatio },
            c.deltaRatio === null ? 0.3 : 0.3 + Math.abs(c.deltaRatio),
          ),
        );

    case 'contribution': {
      if (output.kind === 'additive') {
        const c = output.contribution;
        const top = c.members[0];
        if (!top || top.share === null) return [];
        return [
          finding(
            'driver',
            top.share >= 0 ? 'driver.same_direction' : 'driver.opposite_direction',
            { member: top.member, delta: top.delta, share: top.share, totalDelta: c.totalDelta },
            Math.abs(top.share),
          ),
        ];
      }
      const d = output.decomposition;
      const top = d.members[0];
      if (!top || d.delta === null || d.delta === 0) return [];
      const mixDominates = Math.abs(d.mixEffect) > Math.abs(d.rateEffect);
      return [
        finding(
          'ratio_driver',
          mixDominates ? 'ratio_driver.mix' : 'ratio_driver.rate',
          {
            member: top.member,
            effect: top.effect,
            share: round(top.effect / d.delta),
            rateEffect: d.rateEffect,
            mixEffect: d.mixEffect,
          },
          Math.abs(top.effect / d.delta),
        ),
      ];
    }

    case 'trend':
      return output.trends
        .filter((t) => t.direction !== null)
        .map((t) =>
          finding(
            'trend',
            `trend.${t.direction}`,
            { metric: t.metric, slope: t.slope, r2: t.r2, firstLastRatio: t.firstLastRatio },
            t.direction === 'flat'
              ? 0.1
              : (t.r2 ?? 0) * Math.min(1, Math.abs(t.firstLastRatio ?? 0) + 0.2),
          ),
        );

    case 'distribution': {
      const d = output.distribution;
      if (d.topShare === null) return [];
      return [
        finding(
          'concentration',
          d.topShare >= 0.5 ? 'concentration.high' : 'concentration.spread',
          {
            member: d.top[0]?.member ?? null,
            topShare: d.topShare,
            membersFor80: d.membersFor80,
            members: d.members.length,
          },
          d.hhi ?? 0,
        ),
      ];
    }

    case 'anomaly':
      return output.reports
        .filter((r) => r.anomalies.length > 0)
        .map((r) => {
          const top = [...r.anomalies].sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0]!;
          return finding(
            'anomaly',
            `anomaly.${top.direction}`,
            {
              member: r.member,
              period: top.period.slice(0, 10),
              value: top.value,
              z: top.z,
              count: r.anomalies.length,
            },
            0.4 + Math.min(0.6, Math.abs(top.z) / 20),
          );
        });
  }
}
