import {
  type DatasetColumn,
  Permission,
  type QualityCheckSummary,
  type QualityDimension,
  type RuleResult,
} from '@insightai/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { describeRule } from './describe';
import { isRunning, qualityApi } from './quality-api';
import {
  JobStatusBadge,
  QualityStatusBadge,
  RuleResultBadge,
  ScoreValue,
  SeverityBadge,
} from './quality-badges';
import { RulesPanel } from './rules-panel';

const DIMENSIONS: QualityDimension[] = [
  'completeness',
  'uniqueness',
  'validity',
  'consistency',
  'referential_integrity',
];

/** Quality report of the dataset: latest checks, rule results with failing rows, and rules. */
export function QualityTab({
  datasetId,
  activeVersionId,
  columns,
}: {
  datasetId: string;
  activeVersionId: string;
  columns: DatasetColumn[];
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.QUALITY_WRITE);
  const checksKey = orgKey(organizationId, 'dataset', datasetId, 'quality-checks');
  const [selected, setSelected] = useState<string | null>(null);

  const checks = useQuery({
    queryKey: checksKey,
    queryFn: () => qualityApi.checks(datasetId),
    refetchInterval: (query) => (query.state.data?.some((c) => isRunning(c.status)) ? 2000 : false),
  });
  const run = useMutation({
    mutationFn: () => qualityApi.runCheck(datasetId, activeVersionId),
    onSuccess: async (check) => {
      setSelected(check.id);
      await queryClient.invalidateQueries({ queryKey: checksKey });
    },
  });

  if (checks.isError) return <Alert variant="destructive">{errorMessage(t, checks.error)}</Alert>;
  if (!checks.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  // Default: the latest check of the active version, else the latest check at all.
  const current =
    checks.data.find((c) => c.id === selected) ??
    checks.data.find((c) => c.versionId === activeVersionId) ??
    checks.data[0];

  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="quality-report">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="quality-report" className="text-lg font-semibold">
              {t('quality.report')}
            </h2>
            <p className="text-muted-foreground text-sm">{t('quality.reportHint')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {checks.data.length > 1 && current && (
              <NativeSelect
                aria-label={t('quality.history')}
                className="h-8 w-auto"
                value={current.id}
                onChange={(e) => setSelected(e.target.value)}
              >
                {checks.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t('quality.checkOption', {
                      version: c.versionNo,
                      date: formatDateTime(c.createdAt, lang),
                      score: c.score ?? '—',
                    })}
                  </option>
                ))}
              </NativeSelect>
            )}
            {canWrite && (
              <Button
                size="sm"
                onClick={() => run.mutate()}
                disabled={run.isPending || checks.data.some((c) => isRunning(c.status))}
              >
                <Play />
                {t('quality.runCheck')}
              </Button>
            )}
          </div>
        </div>
        {run.isError && <Alert variant="destructive">{errorMessage(t, run.error)}</Alert>}

        {!current ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('quality.noChecks')}
          </p>
        ) : (
          <CheckReport check={current} activeVersionId={activeVersionId} />
        )}
      </section>

      <RulesPanel datasetId={datasetId} columns={columns} />
    </div>
  );
}

function CheckReport({
  check,
  activeVersionId,
}: {
  check: QualityCheckSummary;
  activeVersionId: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { organizationId } = useActiveOrganization();
  const detail = useQuery({
    queryKey: orgKey(organizationId, 'quality-check', check.id, check.status),
    queryFn: () => qualityApi.check(check.id),
    enabled: check.status === 'SUCCEEDED',
  });

  const meta = (
    <p className="text-muted-foreground text-xs">
      {t('quality.checkMeta', {
        version: check.versionNo,
        trigger: t(`quality.trigger.${check.trigger}`),
        date: formatDateTime(check.finishedAt ?? check.createdAt, lang),
      })}
      {check.versionId !== activeVersionId && ` · ${t('quality.notActiveVersion')}`}
    </p>
  );

  if (isRunning(check.status)) {
    return (
      <div className="space-y-2 rounded-xl border p-6" role="status">
        <JobStatusBadge status={check.status} />
        <p className="text-sm">{t('quality.checkRunning')}</p>
        {meta}
      </div>
    );
  }
  if (check.status === 'FAILED') {
    return (
      <Alert variant="destructive" className="space-y-1">
        <p>{t('quality.checkFailed')}</p>
        {meta}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="bg-card flex flex-col justify-between gap-3 rounded-xl border p-5">
          <div className="flex items-start justify-between gap-2">
            <span className="text-muted-foreground text-sm">{t('quality.score')}</span>
            <QualityStatusBadge status={check.qualityStatus} />
          </div>
          <div className="flex items-baseline gap-1">
            <ScoreValue score={check.score} status={check.qualityStatus} className="text-5xl" />
            <span className="text-muted-foreground text-sm">/ 100</span>
          </div>
          <p className="text-sm">
            {t('quality.rulesFailed', { failed: check.rulesFailed, total: check.rulesTotal })}
          </p>
          {meta}
        </div>
        <div className="bg-card space-y-3 rounded-xl border p-5">
          <h3 className="text-sm font-medium">{t('quality.byDimension')}</h3>
          <ul className="space-y-2.5">
            {DIMENSIONS.map((dimension) => {
              const value = check.dimensionScores[dimension];
              return (
                <li
                  key={dimension}
                  className="grid grid-cols-[8.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)_3rem]"
                >
                  <span className="truncate" title={t(`quality.dimension.${dimension}`)}>
                    {t(`quality.dimension.${dimension}`)}
                  </span>
                  <div
                    className="bg-muted h-2 overflow-hidden rounded-full"
                    role="meter"
                    aria-label={t(`quality.dimension.${dimension}`)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={value ?? undefined}
                  >
                    {value !== null && value !== undefined && (
                      <div
                        className={cn(
                          'h-full rounded-full',
                          value >= 95
                            ? 'bg-success'
                            : value >= 80
                              ? 'bg-warning'
                              : 'bg-destructive',
                        )}
                        style={{ width: `${value}%` }}
                      />
                    )}
                  </div>
                  <span className="text-muted-foreground text-right tabular-nums">
                    {value === null || value === undefined
                      ? '—'
                      : value.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US')}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {detail.isError && <Alert variant="destructive">{errorMessage(t, detail.error)}</Alert>}
      {detail.data && <ResultsTable checkId={check.id} results={detail.data.results} />}
    </div>
  );
}

function ResultsTable({ checkId, results }: { checkId: string; results: RuleResult[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [open, setOpen] = useState<string | null>(null);

  if (results.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('quality.noResults')}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>{t('quality.rule')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('quality.dimensionLabel')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('quality.severityLabel')}</TableHead>
          <TableHead>{t('quality.result')}</TableHead>
          <TableHead className="text-right">{t('quality.failedRows')}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t('quality.passRate')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map((result) => {
          const expandable = result.sampleCount > 0;
          const isOpen = open === result.id;
          return (
            <ResultRows
              key={result.id}
              checkId={checkId}
              result={result}
              expandable={expandable}
              isOpen={isOpen}
              onToggle={() => setOpen(isOpen ? null : result.id)}
              lang={lang}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function ResultRows({
  checkId,
  result,
  expandable,
  isOpen,
  onToggle,
  lang,
}: {
  checkId: string;
  result: RuleResult;
  expandable: boolean;
  isOpen: boolean;
  onToggle: () => void;
  lang: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TableRow className={cn(isOpen && 'bg-muted/40')}>
        <TableCell className="px-1">
          {expandable && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-expanded={isOpen}
              aria-label={t('quality.showIssues', { rule: result.ruleName })}
              onClick={onToggle}
            >
              {isOpen ? <ChevronDown /> : <ChevronRight />}
            </Button>
          )}
        </TableCell>
        <TableCell className="max-w-md">
          <div className="font-medium">{result.ruleName}</div>
          <div
            className="text-muted-foreground truncate text-xs"
            title={describeRule(t, result.definition)}
          >
            {describeRule(t, result.definition)}
          </div>
          {result.message && <div className="text-destructive text-xs">{result.message}</div>}
        </TableCell>
        <TableCell className="text-muted-foreground hidden lg:table-cell">
          {t(`quality.dimension.${result.dimension}`)}
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <SeverityBadge severity={result.severity} />
        </TableCell>
        <TableCell>
          <RuleResultBadge status={result.status} />
        </TableCell>
        <TableCell
          className={cn(
            'text-right tabular-nums',
            result.failedCount > 0 ? 'text-destructive font-medium' : 'text-muted-foreground',
          )}
        >
          {formatNumber(result.failedCount, lang)}
          <span className="text-muted-foreground font-normal">
            {' / '}
            {formatNumber(result.evaluatedCount, lang)}
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground hidden text-right tabular-nums md:table-cell">
          {result.passRate === null ? '—' : formatPercent(result.passRate, lang)}
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-muted/20 p-3">
            <IssuesTable checkId={checkId} result={result} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Sample of failing rows (≤ 100 per rule) with the typed and original values. */
function IssuesTable({ checkId, result }: { checkId: string; result: RuleResult }) {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const issues = useInfiniteQuery({
    queryKey: orgKey(organizationId, 'quality-issues', checkId, result.id),
    queryFn: ({ pageParam }) => qualityApi.issues(checkId, result.id, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => (page.nextCursor ? Number(page.nextCursor) : undefined),
  });

  if (issues.isError) return <Alert variant="destructive">{errorMessage(t, issues.error)}</Alert>;
  if (!issues.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  const items = issues.data.pages.flatMap((p) => p.items);

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {t('quality.issuesSample', {
          shown: formatNumber(result.sampleCount, i18n.language),
          total: formatNumber(result.failedCount, i18n.language),
        })}
      </p>
      <div className="bg-background max-h-80 overflow-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr className="text-muted-foreground text-left text-xs">
              <th className="px-3 py-2 font-medium">{t('quality.rowId')}</th>
              <th className="px-3 py-2 font-medium">{t('quality.column')}</th>
              <th className="px-3 py-2 font-medium">{t('quality.value')}</th>
              <th className="px-3 py-2 font-medium">{t('quality.rawValue')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((issue, index) => (
              <tr key={`${issue.rowId}-${index}`} className="border-t">
                <td className="text-muted-foreground px-3 py-1.5 tabular-nums">#{issue.rowId}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{issue.column ?? '—'}</td>
                <td className="px-3 py-1.5">
                  {issue.value ?? <Badge variant="secondary">{t('quality.empty')}</Badge>}
                </td>
                <td className="text-muted-foreground px-3 py-1.5">{issue.rawValue ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {issues.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void issues.fetchNextPage()}
          disabled={issues.isFetchingNextPage}
        >
          {t('quality.moreIssues')}
        </Button>
      )}
    </div>
  );
}
