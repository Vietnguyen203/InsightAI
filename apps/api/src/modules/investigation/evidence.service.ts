import { Injectable } from '@nestjs/common';
import type { AnalysisPlan, HypothesisStatus } from '@insightai/contracts';
import { uuidv7 } from '../../platform/crypto/ids';
import {
  type DbContext,
  type DbTransaction,
  PrismaService,
} from '../../platform/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ToolOutput, ToolRun } from './analysis-tools.service';
import { evidenceValues, outputLimitations } from './validation/evidence-values';
import { deriveFindings } from './validation/findings';
import { DEFAULT_THRESHOLDS, evaluateHypothesis } from './validation/hypothesis-rules';

type Db = Required<Pick<DbContext, 'organizationId' | 'userId'>>;

export interface ValidationSummary {
  hypotheses: { key: string; status: HypothesisStatus }[];
  findings: number;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Evidence, hypotheses and findings (docs/PHASE6_AI_ANALYST_DESIGN.md §2.7). Evidence freezes
 * what a step proved – queries, versions, policies, result rows – in the same transaction that
 * marks the step done, so a resumed run never has a finished step without its evidence.
 */
@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async recordStep(db: Db, investigationId: string, stepId: string, run: ToolRun): Promise<string> {
    const evidenceId = uuidv7();
    const historyIds = run.results.map((r) => r.queryHistoryId).filter((x): x is string => !!x);
    await this.prisma.runInContext(db, async (tx) => {
      const datasets = await this.datasets(tx, historyIds);
      const metrics = new Map<string, number>();
      for (const r of run.results) for (const m of r.metrics) metrics.set(m.key, m.version);
      const limitations = [
        ...new Set([
          ...outputLimitations(run.output),
          ...(run.results.some((r) => r.truncated) ? ['TRUNCATED'] : []),
          ...(run.results.some((r) => r.policiesApplied.length > 0) ? ['POLICY_FILTERED'] : []),
        ]),
      ];
      await tx.investigationStep.update({
        where: { id: stepId },
        data: {
          status: 'SUCCEEDED',
          output: json(run.output),
          queryHistoryIds: historyIds,
          finishedAt: new Date(),
        },
      });
      await tx.evidence.createMany({
        data: {
          id: evidenceId,
          organizationId: db.organizationId,
          investigationId,
          stepId,
          kind: run.output.tool,
          queries: json(run.queries),
          queryHistoryIds: historyIds,
          versions: json({
            modelRevision: run.results[0]?.modelRevision ?? 0,
            metrics: [...metrics].map(([key, version]) => ({ key, version })),
            datasets,
          }),
          policiesApplied: [...new Set(run.results.flatMap((r) => r.policiesApplied))],
          results: json(run.results),
          values: json(evidenceValues(run.output)),
          limitations,
        },
      });
    });
    return evidenceId;
  }

  /**
   * Evaluates the plan's hypotheses with the deterministic rules and derives the findings.
   * Idempotent: a resumed validation replaces its earlier results.
   */
  async validate(db: Db, investigationId: string, plan: AnalysisPlan): Promise<ValidationSummary> {
    return this.prisma.runInContext(db, async (tx) => {
      const steps = await tx.investigationStep.findMany({
        where: { investigationId },
        orderBy: { position: 'asc' },
      });
      const evidence = await tx.evidence.findMany({
        where: { investigationId },
        select: { id: true, stepId: true, limitations: true },
      });
      const outputOf = (stepKey: string) => {
        const step = steps.find((s) => s.stepKey === stepKey);
        return step?.status === 'SUCCEEDED' ? (step.output as unknown as ToolOutput) : null;
      };
      const evidenceOf = (stepKey: string) => {
        const step = steps.find((s) => s.stepKey === stepKey);
        return evidence.filter((e) => e.stepId === step?.id).map((e) => e.id);
      };

      const hypotheses = plan.hypotheses.map((h) => ({
        h,
        evaluation: evaluateHypothesis(h, outputOf(h.expectation.stepId), DEFAULT_THRESHOLDS),
      }));
      const findings = evidence
        .flatMap((e) => {
          const step = steps.find((s) => s.id === e.stepId);
          return step?.output
            ? deriveFindings(step.output as unknown as ToolOutput, e.id, e.limitations)
            : [];
        })
        .sort((a, b) => b.importance - a.importance);

      await tx.investigationHypothesis.deleteMany({ where: { investigationId } });
      await tx.investigationFinding.deleteMany({ where: { investigationId } });
      await tx.investigationHypothesis.createMany({
        data: hypotheses.map(({ h, evaluation }) => ({
          id: uuidv7(),
          organizationId: db.organizationId,
          investigationId,
          key: h.id,
          statement: h.statement,
          status: evaluation.status,
          rule: json(evaluation.rule),
          evidenceIds: evaluation.status === 'UNTESTED' ? [] : evidenceOf(h.expectation.stepId),
        })),
      });
      await tx.investigationFinding.createMany({
        data: findings.map((f, position) => ({
          id: uuidv7(),
          organizationId: db.organizationId,
          investigationId,
          position,
          kind: f.kind,
          templateKey: f.templateKey,
          params: json(f.params),
          evidenceIds: f.evidenceIds,
          verified: f.verified,
          importance: f.importance,
          limitations: f.limitations,
        })),
      });
      return {
        hypotheses: hypotheses.map(({ h, evaluation }) => ({
          key: h.id,
          status: evaluation.status,
        })),
        findings: findings.length,
      };
    });
  }

  /** Datasets (versions and quality) behind the queries, from the query history. */
  private async datasets(tx: DbTransaction, historyIds: string[]) {
    if (historyIds.length === 0) return [];
    const history = await tx.queryHistory.findMany({
      where: { id: { in: historyIds } },
      select: { datasetVersionIds: true },
    });
    const ids = [...new Set(history.flatMap((h) => h.datasetVersionIds))];
    const versions = await tx.datasetVersion.findMany({
      where: { id: { in: ids } },
      include: { dataset: { select: { name: true } } },
    });
    return versions.map((v) => ({
      id: v.datasetId,
      name: v.dataset.name,
      versionNo: v.versionNo,
      qualityScore: v.qualityScore === null ? null : Number(v.qualityScore),
    }));
  }
}
