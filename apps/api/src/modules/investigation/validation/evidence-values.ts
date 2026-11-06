import type { ToolOutput } from '../analysis-tools.service';

export type EvidenceValue = string | number | null;

const TOP = 5;

/**
 * Named figures of a step's deterministic output, for the report's placeholders
 * (`{{ev:<evidenceId>.<name>}}`). Business figures stay exact decimal strings; statistics are
 * the rounded numbers of the engines. Member names are values too, never keys.
 */
export function evidenceValues(output: ToolOutput): Record<string, EvidenceValue> {
  const v: Record<string, EvidenceValue> = {};
  switch (output.tool) {
    case 'metric_snapshot': {
      const r = output.result;
      v.rows = r.rows.length;
      if (r.rows.length === 1) {
        r.columns.forEach((c, i) => {
          if (c.kind === 'metric' || c.kind === 'measure')
            v[c.comparison ? `${c.key}.previous` : c.key] = r.rows[0]![i] ?? null;
        });
      }
      break;
    }
    case 'compare_periods':
      for (const c of output.comparisons) {
        v[`${c.metric}.current`] = c.current;
        v[`${c.metric}.baseline`] = c.baseline;
        v[`${c.metric}.delta`] = c.delta;
        v[`${c.metric}.deltaRatio`] = c.deltaRatio;
        v[`${c.metric}.direction`] = c.direction;
      }
      break;
    case 'contribution':
      if (output.kind === 'additive') {
        const c = output.contribution;
        v['total.current'] = c.totalCurrent;
        v['total.baseline'] = c.totalBaseline;
        v['total.delta'] = c.totalDelta;
        v.members = c.members.length;
        c.top.slice(0, TOP).forEach((m, i) => {
          v[`top.${i}.member`] = m.member;
          v[`top.${i}.current`] = m.current;
          v[`top.${i}.baseline`] = m.baseline;
          v[`top.${i}.delta`] = m.delta;
          v[`top.${i}.share`] = m.share;
        });
        if (c.others) {
          v['others.count'] = c.others.count;
          v['others.delta'] = c.others.delta;
          v['others.share'] = c.others.share;
        }
      } else {
        const d = output.decomposition;
        v['ratio.current'] = d.ratioCurrent;
        v['ratio.baseline'] = d.ratioBaseline;
        v['ratio.delta'] = d.delta;
        v.rateEffect = d.rateEffect;
        v.mixEffect = d.mixEffect;
        v.residual = d.residual;
        d.members.slice(0, TOP).forEach((m, i) => {
          v[`top.${i}.member`] = m.member;
          v[`top.${i}.effect`] = m.effect;
          v[`top.${i}.rateEffect`] = m.rateEffect;
          v[`top.${i}.mixEffect`] = m.mixEffect;
        });
      }
      break;
    case 'trend':
      for (const t of output.trends) {
        v[`${t.metric}.slope`] = t.slope;
        v[`${t.metric}.r2`] = t.r2;
        v[`${t.metric}.direction`] = t.direction;
        v[`${t.metric}.firstLastDelta`] = t.firstLastDelta;
        v[`${t.metric}.firstLastRatio`] = t.firstLastRatio;
        v[`${t.metric}.points`] = t.fitted;
      }
      break;
    case 'distribution': {
      const d = output.distribution;
      v.total = d.total;
      v.topShare = d.topShare;
      v.membersFor80 = d.membersFor80;
      v.members = d.members.length;
      v.hhi = d.hhi;
      v.gini = d.gini;
      d.top.slice(0, TOP).forEach((m, i) => {
        v[`top.${i}.member`] = m.member;
        v[`top.${i}.value`] = m.value;
        v[`top.${i}.share`] = m.share;
      });
      break;
    }
    case 'anomaly': {
      const withAnomalies = output.reports.filter((r) => r.anomalies.length > 0);
      v.series = output.reports.length;
      v.anomalies = withAnomalies.reduce((n, r) => n + r.anomalies.length, 0);
      withAnomalies
        .map((r) => ({
          r,
          top: [...r.anomalies].sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0]!,
        }))
        .sort((a, b) => Math.abs(b.top.z) - Math.abs(a.top.z))
        .slice(0, TOP)
        .forEach(({ r, top }, i) => {
          v[`top.${i}.member`] = r.member;
          v[`top.${i}.period`] = top.period.slice(0, 10);
          v[`top.${i}.value`] = top.value;
          v[`top.${i}.z`] = top.z;
          v[`top.${i}.direction`] = top.direction;
          v[`top.${i}.count`] = r.anomalies.length;
        });
      break;
    }
  }
  return v;
}

/** Limitations reported by the engines inside a step's output. */
export function outputLimitations(output: ToolOutput): string[] {
  const all: string[] = [];
  switch (output.tool) {
    case 'compare_periods':
      output.comparisons.forEach((c) => all.push(...c.limitations));
      break;
    case 'contribution':
      all.push(
        ...(output.kind === 'additive'
          ? output.contribution.limitations
          : output.decomposition.limitations),
      );
      break;
    case 'trend':
      output.trends.forEach((t) => all.push(...t.limitations));
      break;
    case 'distribution':
      all.push(...output.distribution.limitations);
      break;
    case 'anomaly':
      output.reports.forEach((r) => all.push(...r.limitations));
      break;
    case 'metric_snapshot':
      if (output.result.truncated) all.push('TRUNCATED');
      if (output.result.rows.length === 0) all.push('NO_DATA');
      if (output.result.policiesApplied.length > 0) all.push('POLICY_FILTERED');
      break;
  }
  return [...new Set(all)];
}
