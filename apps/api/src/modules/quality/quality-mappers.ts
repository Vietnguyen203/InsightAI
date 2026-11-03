import {
  type QualityCheckSummary,
  type QualityDimension,
  type QualityRule as QualityRuleDto,
  type RuleDefinition,
  type RuleResult,
  ruleDefinitionSchema,
} from '@insightai/contracts';
import type { QualityCheck, QualityCheckResult, QualityRule } from '../../generated/prisma/client';

export interface RuleSnapshot {
  name: string;
  dimension: QualityDimension;
  definition: RuleDefinition;
  severity: 'info' | 'warning' | 'error';
  weight: number;
  threshold: number;
}

export function toRuleDto(rule: QualityRule): QualityRuleDto {
  return {
    id: rule.id,
    datasetId: rule.datasetId,
    name: rule.name,
    dimension: rule.dimension as QualityDimension,
    definition: ruleDefinitionSchema.parse(rule.definition),
    severity: rule.severity,
    weight: rule.weight,
    threshold: Number(rule.threshold),
    enabled: rule.enabled,
    origin: rule.origin === 'system' ? 'system' : 'user',
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export function snapshotOf(rule: QualityRule): RuleSnapshot {
  return {
    name: rule.name,
    dimension: rule.dimension as QualityDimension,
    definition: ruleDefinitionSchema.parse(rule.definition),
    severity: rule.severity,
    weight: rule.weight,
    threshold: Number(rule.threshold),
  };
}

export function toCheckSummary(
  check: QualityCheck & { version: { versionNo: number } },
): QualityCheckSummary {
  return {
    id: check.id,
    datasetId: check.datasetId,
    versionId: check.datasetVersionId,
    versionNo: check.version.versionNo,
    trigger: check.trigger,
    status: check.status,
    score: check.score === null ? null : Number(check.score),
    qualityStatus: check.qualityStatus,
    dimensionScores: check.dimensionScores as QualityCheckSummary['dimensionScores'],
    rulesTotal: check.rulesTotal,
    rulesFailed: check.rulesFailed,
    error: (check.error as QualityCheckSummary['error']) ?? null,
    createdAt: check.createdAt.toISOString(),
    finishedAt: check.finishedAt?.toISOString() ?? null,
  };
}

export function toRuleResult(result: QualityCheckResult): RuleResult {
  const snapshot = result.ruleSnapshot as unknown as RuleSnapshot;
  return {
    id: result.id,
    ruleId: result.qualityRuleId,
    ruleName: snapshot.name,
    dimension: snapshot.dimension,
    definition: snapshot.definition,
    severity: snapshot.severity,
    weight: snapshot.weight,
    threshold: snapshot.threshold,
    status: result.status,
    evaluatedCount: Number(result.evaluatedCount),
    failedCount: Number(result.failedCount),
    passRate: result.passRate === null ? null : Number(result.passRate),
    message: result.message,
    sampleCount: result.sampleCount,
  };
}
