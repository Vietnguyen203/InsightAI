import { Injectable } from '@nestjs/common';
import type {
  Catalog,
  DateRange,
  SemanticQueryFilter,
  SemanticQueryParsed,
  SemanticQueryResult,
} from '@insightai/contracts';
import { QueryRejectedError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { QueryEngineService } from '../query-engine/query-engine.service';
import { SemanticMetricService } from '../semantic/semantic-metric.service';
import { type AnomalyReport, anomaliesFromResult } from './analysis/anomaly';
import {
  type Comparison,
  comparisonsFromCompareResult,
  comparisonsFromTwoResults,
} from './analysis/comparison';
import {
  type Contribution,
  contribution,
  membersFromCompareResult,
  membersFromTwoResults,
  type RatioDecomposition,
  ratioDecomposition,
} from './analysis/contribution';
import { type Distribution, distributionFromResult } from './analysis/distribution';
import type { Granularity } from './analysis/periods';
import { columnIndex, resultLimitations, unique } from './analysis/result';
import { type Trend, trendFromResult } from './analysis/trend';

export type Baseline = DateRange | 'previous_period' | 'same_period_last_year';

interface Common {
  model: string;
  filters?: SemanticQueryFilter[];
}

/** Inputs of the controlled analysis tools (the Plan IR of 6C maps onto these). */
export type ToolInput = Common &
  (
    | { tool: 'metric_snapshot'; metrics: string[]; period?: DateRange }
    | { tool: 'compare_periods'; metrics: string[]; current: DateRange; baseline: Baseline }
    | {
        tool: 'contribution';
        metric: string;
        dimension: string;
        current: DateRange;
        baseline: Baseline;
        k?: number;
      }
    | {
        tool: 'trend';
        metrics: string[];
        granularity: Exclude<Granularity, 'year'>;
        period: DateRange;
      }
    | { tool: 'distribution'; metric: string; dimension: string; period?: DateRange; k?: number }
    | {
        tool: 'anomaly';
        metric: string;
        granularity: 'day' | 'week';
        period: DateRange;
        dimension?: string;
      }
  );

export type ToolOutput =
  | { tool: 'metric_snapshot'; result: SemanticQueryResult }
  | { tool: 'compare_periods'; comparisons: Comparison[] }
  | { tool: 'contribution'; kind: 'additive'; contribution: Contribution }
  | { tool: 'contribution'; kind: 'ratio'; decomposition: RatioDecomposition }
  | { tool: 'trend'; trends: Trend[] }
  | { tool: 'distribution'; distribution: Distribution }
  | { tool: 'anomaly'; reports: AnomalyReport[] };

export interface ToolRun {
  /** Every query that ran, in order (Semantic Query IR only – never SQL). */
  queries: SemanticQueryParsed[];
  results: SemanticQueryResult[];
  output: ToolOutput;
}

/** Contribution analysis needs a metric whose parts add up (or a ratio of two such metrics). */
export class NotAdditiveError extends QueryRejectedError {
  constructor(metric: string) {
    super(`Metric "${metric}" cannot be split into contributions`, [
      { path: 'reason.NOT_ADDITIVE', message: `Metric "${metric}" is not additive` },
    ]);
  }
}

const GROUP_LIMIT = 1000;

/**
 * Controlled analysis tools (docs/PHASE6_AI_ANALYST_DESIGN.md §2.6). Each tool turns its input
 * into Semantic Queries, runs them through the query engine **as the given user** (policies,
 * SQL validation, cache and history apply), then computes its result deterministically.
 */
@Injectable()
export class AnalysisToolsService {
  constructor(
    private readonly engine: QueryEngineService,
    private readonly metrics: SemanticMetricService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: TenantContext, input: ToolInput): Promise<ToolRun> {
    const queries: SemanticQueryParsed[] = [];
    const results: SemanticQueryResult[] = [];
    const exec = async (query: SemanticQueryParsed) => {
      queries.push(query);
      const result = await this.engine.run(ctx, query, 'INVESTIGATION');
      results.push(result);
      return result;
    };
    const filters = input.filters ?? [];
    const q = (parts: Partial<SemanticQueryParsed>): SemanticQueryParsed => ({
      model: input.model,
      metrics: [],
      measures: [],
      dimensions: [],
      filters,
      orderBy: [],
      limit: GROUP_LIMIT,
      ...parts,
    });

    switch (input.tool) {
      case 'metric_snapshot': {
        const result = await exec(
          q({
            metrics: input.metrics,
            ...(input.period ? { timeDimension: { dateRange: input.period } } : {}),
          }),
        );
        return { queries, results, output: { tool: input.tool, result } };
      }

      case 'compare_periods': {
        if (typeof input.baseline === 'string') {
          const result = await exec(
            q({
              metrics: input.metrics,
              timeDimension: { dateRange: input.current, compareTo: input.baseline },
            }),
          );
          return {
            queries,
            results,
            output: {
              tool: input.tool,
              comparisons: comparisonsFromCompareResult(result, input.metrics),
            },
          };
        }
        const current = await exec(
          q({ metrics: input.metrics, timeDimension: { dateRange: input.current } }),
        );
        const baseline = await exec(
          q({ metrics: input.metrics, timeDimension: { dateRange: input.baseline } }),
        );
        return {
          queries,
          results,
          output: {
            tool: input.tool,
            comparisons: comparisonsFromTwoResults(current, baseline, input.metrics),
          },
        };
      }

      case 'contribution':
        return this.contribution(ctx, input, q, exec, queries, results);

      case 'trend': {
        const result = await exec(
          q({
            metrics: input.metrics,
            timeDimension: { granularity: input.granularity, dateRange: input.period },
          }),
        );
        const today = await this.today(ctx);
        return {
          queries,
          results,
          output: {
            tool: input.tool,
            trends: input.metrics.map((m) => trendFromResult(result, m, input.granularity, today)),
          },
        };
      }

      case 'distribution': {
        const result = await exec(
          q({
            metrics: [input.metric],
            dimensions: [input.dimension],
            orderBy: [{ member: input.metric, dir: 'desc' }],
            ...(input.period ? { timeDimension: { dateRange: input.period } } : {}),
          }),
        );
        return {
          queries,
          results,
          output: {
            tool: input.tool,
            distribution: distributionFromResult(result, input.metric, input.dimension, input.k),
          },
        };
      }

      case 'anomaly': {
        const result = await exec(
          q({
            metrics: [input.metric],
            dimensions: input.dimension ? [input.dimension] : [],
            timeDimension: { granularity: input.granularity, dateRange: input.period },
          }),
        );
        return {
          queries,
          results,
          output: {
            tool: input.tool,
            reports: anomaliesFromResult(result, input.metric, input.dimension),
          },
        };
      }
    }
  }

  private async contribution(
    ctx: TenantContext,
    input: Extract<ToolInput, { tool: 'contribution' }>,
    q: (parts: Partial<SemanticQueryParsed>) => SemanticQueryParsed,
    exec: (query: SemanticQueryParsed) => Promise<SemanticQueryResult>,
    queries: SemanticQueryParsed[],
    results: SemanticQueryResult[],
  ): Promise<ToolRun> {
    const catalog = await this.metrics.catalog(ctx, input.model);
    const metric = catalog.metrics.find((m) => m.key === input.metric);
    if (!metric) {
      throw new QueryRejectedError(`Unknown metric "${input.metric}"`, [
        { path: 'reason.UNKNOWN_METRIC', message: input.metric },
      ]);
    }
    const ratio = metric.ratio && bothAdditive(catalog, metric.ratio) ? metric.ratio : null;
    if (!metric.additive && !ratio) throw new NotAdditiveError(input.metric);
    const measured = ratio ? [ratio.numerator, ratio.denominator] : [input.metric];
    const dims = [input.dimension];

    // Grouped values of both periods (one query with compareTo, or one query per period).
    let members: (metricKey: string) => ReturnType<typeof membersFromCompareResult>;
    let limitations: ReturnType<typeof resultLimitations>;
    if (typeof input.baseline === 'string') {
      const grouped = await exec(
        q({
          metrics: measured,
          dimensions: dims,
          timeDimension: { dateRange: input.current, compareTo: input.baseline },
        }),
      );
      members = (m) => membersFromCompareResult(grouped, m, input.dimension);
      limitations = resultLimitations(grouped);
    } else {
      const current = await exec(
        q({ metrics: measured, dimensions: dims, timeDimension: { dateRange: input.current } }),
      );
      const baseline = await exec(
        q({ metrics: measured, dimensions: dims, timeDimension: { dateRange: input.baseline } }),
      );
      members = (m) => membersFromTwoResults(current, baseline, m, input.dimension);
      limitations = resultLimitations(current, baseline);
    }

    if (ratio) {
      const num = new Map(members(ratio.numerator).map((r) => [r.member, r]));
      const rows = members(ratio.denominator).map((d) => ({
        member: d.member,
        numerator: {
          current: num.get(d.member)?.current ?? null,
          baseline: num.get(d.member)?.baseline ?? null,
        },
        denominator: { current: d.current, baseline: d.baseline },
      }));
      const decomposition = ratioDecomposition(rows);
      return {
        queries,
        results,
        output: {
          tool: 'contribution',
          kind: 'ratio',
          decomposition: {
            ...decomposition,
            limitations: unique([...limitations, ...decomposition.limitations]),
          },
        },
      };
    }

    // The total without the dimension: members must add up to it (exact decimals).
    const total = await exec(
      q({
        metrics: [input.metric],
        timeDimension:
          typeof input.baseline === 'string'
            ? { dateRange: input.current, compareTo: input.baseline }
            : { dateRange: input.current },
      }),
    );
    let reportedTotal: { current: string | null; baseline: string | null };
    if (typeof input.baseline === 'string') {
      const row = total.rows[0];
      reportedTotal = {
        current: row?.[columnIndex(total, input.metric)] ?? null,
        baseline: row?.[columnIndex(total, input.metric, true)] ?? null,
      };
    } else {
      const totalBaseline = await exec(
        q({ metrics: [input.metric], timeDimension: { dateRange: input.baseline } }),
      );
      reportedTotal = {
        current: total.rows[0]?.[0] ?? null,
        baseline: totalBaseline.rows[0]?.[0] ?? null,
      };
    }
    const result = contribution(members(input.metric), { k: input.k, reportedTotal });
    return {
      queries,
      results,
      output: {
        tool: 'contribution',
        kind: 'additive',
        contribution: { ...result, limitations: unique([...limitations, ...result.limitations]) },
      },
    };
  }

  /** Today in the organization's time zone (to recognize the incomplete current period). */
  private async today(ctx: TenantContext): Promise<string> {
    const org = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    );
    return new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(new Date());
  }
}

function bothAdditive(catalog: Catalog, ratio: { numerator: string; denominator: string }) {
  const additive = (key: string) => catalog.metrics.find((m) => m.key === key)?.additive === true;
  return additive(ratio.numerator) && additive(ratio.denominator);
}
