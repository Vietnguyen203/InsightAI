import { type DatasetVersion, Permission, type VersionComparison } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, GitCompare } from 'lucide-react';
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
import { qualityApi } from './quality-api';
import { QualityStatusBadge, ScoreValue } from './quality-badges';

/**
 * Version timeline: every import and cleaning result is kept. Any version can be activated;
 * activating an older one is the rollback. Two versions can be compared side by side.
 */
export function VersionsTab({
  datasetId,
  versions,
  activeVersionId,
  focusVersionId,
}: {
  datasetId: string;
  versions: DatasetVersion[];
  activeVersionId: string | null;
  /** Version to compare with its parent when the tab opens (e.g. right after cleaning). */
  focusVersionId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canActivate = usePermission(Permission.DATASET_WRITE);

  const focus = versions.find((v) => v.id === focusVersionId);
  const defaultTarget = focus ?? versions[0];
  const defaultBase =
    versions.find((v) => v.id === defaultTarget?.parentVersionId) ??
    versions.find((v) => v.id === activeVersionId && v.id !== defaultTarget?.id) ??
    versions[1];
  const [base, setBase] = useState(defaultBase?.id ?? '');
  const [target, setTarget] = useState(defaultTarget?.id ?? '');

  const activate = useMutation({
    mutationFn: (versionId: string) => qualityApi.activateVersion(datasetId, versionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dataset', datasetId) }),
  });
  const comparison = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'compare', base, target),
    queryFn: () => qualityApi.compareVersions(datasetId, base, target),
    enabled: base !== '' && target !== '' && base !== target,
  });

  const byId = new Map(versions.map((v) => [v.id, v]));

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="versions-timeline">
        <div className="space-y-1">
          <h2 id="versions-timeline" className="text-lg font-semibold">
            {t('versions.title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('versions.hint')}</p>
        </div>
        {activate.isError && <Alert variant="destructive">{errorMessage(t, activate.error)}</Alert>}
        <ol className="relative space-y-3 border-l pl-6">
          {versions.map((v) => {
            const active = v.id === activeVersionId;
            const parent = v.parentVersionId ? byId.get(v.parentVersionId) : undefined;
            return (
              <li key={v.id} className="relative">
                <span
                  className={cn(
                    'bg-background absolute top-4 -left-[1.82rem] size-3 rounded-full border-2',
                    active ? 'border-primary bg-primary' : 'border-muted-foreground/40',
                  )}
                  aria-hidden
                />
                <div
                  className={cn(
                    'bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4',
                    active && 'border-primary/50 ring-primary/20 ring-2',
                    v.id === focusVersionId && !active && 'border-primary/40',
                  )}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {t('datasets.versionLabel', { n: v.versionNo })}
                      </span>
                      <Badge variant={v.origin === 'CLEANING' ? 'outline' : 'secondary'}>
                        {t(`versions.origin.${v.origin}`)}
                      </Badge>
                      {active && (
                        <Badge>
                          <CheckCircle2 />
                          {t('versions.active')}
                        </Badge>
                      )}
                      <QualityStatusBadge status={v.qualityStatus} />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t('datasets.rowsCount', { rows: formatNumber(v.rowCount, lang) })} ·{' '}
                      {formatDateTime(v.createdAt, lang)}
                      {parent && ` · ${t('versions.cleanedFrom', { n: parent.versionNo })}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-muted-foreground text-xs">{t('quality.score')}</div>
                      <ScoreValue
                        score={v.qualityScore}
                        status={v.qualityStatus}
                        className="text-lg"
                      />
                    </div>
                    {canActivate && !active && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={activate.isPending}
                        onClick={() => {
                          const older =
                            activeVersionId !== null &&
                            v.versionNo < (byId.get(activeVersionId)?.versionNo ?? 0);
                          const message = older
                            ? t('versions.rollbackConfirm', { n: v.versionNo })
                            : t('versions.activateConfirm', { n: v.versionNo });
                          if (window.confirm(message)) activate.mutate(v.id);
                        }}
                      >
                        {activeVersionId !== null &&
                        v.versionNo < (byId.get(activeVersionId)?.versionNo ?? 0)
                          ? t('versions.rollback')
                          : t('versions.activate')}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {versions.length > 1 && (
        <section className="space-y-4" aria-labelledby="versions-compare">
          <div className="flex items-center gap-2">
            <GitCompare className="text-primary size-4" aria-hidden />
            <h2 id="versions-compare" className="text-lg font-semibold">
              {t('versions.compare')}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={t('versions.base')}
              className="h-8 w-auto"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {t('datasets.versionLabel', { n: v.versionNo })}
                </option>
              ))}
            </NativeSelect>
            <ArrowRight className="text-muted-foreground size-4" aria-hidden />
            <NativeSelect
              aria-label={t('versions.target')}
              className="h-8 w-auto"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {t('datasets.versionLabel', { n: v.versionNo })}
                </option>
              ))}
            </NativeSelect>
          </div>
          {base === target ? (
            <p className="text-muted-foreground text-sm">{t('versions.pickTwo')}</p>
          ) : comparison.isError ? (
            <Alert variant="destructive">{errorMessage(t, comparison.error)}</Alert>
          ) : !comparison.data ? (
            <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
          ) : (
            <ComparisonView comparison={comparison.data} />
          )}
        </section>
      )}
    </div>
  );
}

function ComparisonView({ comparison }: { comparison: VersionComparison }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { base, target, rows } = comparison;
  const scoreDelta =
    base.qualityScore !== null && target.qualityScore !== null
      ? Math.round((target.qualityScore - base.qualityScore) * 10) / 10
      : null;
  const changedColumns = comparison.columns.filter(
    (c) => c.status !== 'unchanged' || (c.changedRows ?? 0) > 0,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t('quality.score')}>
          <ScoreValue score={base.qualityScore} status={base.qualityStatus} />
          <ArrowRight className="text-muted-foreground size-4" aria-hidden />
          <ScoreValue score={target.qualityScore} status={target.qualityStatus} />
          {scoreDelta !== null && scoreDelta !== 0 && (
            <span className={cn('text-xs', scoreDelta > 0 ? 'text-success' : 'text-destructive')}>
              {scoreDelta > 0 ? '+' : ''}
              {scoreDelta.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US')}
            </span>
          )}
        </Tile>
        <Tile label={t('versions.rows')}>
          <span className="tabular-nums">{formatNumber(base.rowCount, lang)}</span>
          <ArrowRight className="text-muted-foreground size-4" aria-hidden />
          <span className="tabular-nums">{formatNumber(target.rowCount, lang)}</span>
        </Tile>
        <Tile label={t('versions.rowsChanged')}>
          <span className="tabular-nums">{formatNumber(rows.changed, lang)}</span>
        </Tile>
        <Tile label={t('versions.rowsRemovedAdded')}>
          <span className={cn('tabular-nums', rows.removed > 0 && 'text-destructive')}>
            −{formatNumber(rows.removed, lang)}
          </span>
          <span className="text-muted-foreground">/</span>
          <span className="tabular-nums">+{formatNumber(rows.added, lang)}</span>
        </Tile>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('versions.columns')}</h3>
        {changedColumns.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('versions.noColumnChanges')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {changedColumns.map((c) => (
              <Badge key={c.name} variant={c.status === 'removed' ? 'destructive' : 'outline'}>
                <span className="font-mono">{c.name}</span>
                {c.status === 'retyped' && c.baseType && c.targetType
                  ? ` · ${t(`datasets.types.${c.baseType}`)} → ${t(`datasets.types.${c.targetType}`)}`
                  : c.status !== 'unchanged'
                    ? ` · ${t(`versions.columnStatus.${c.status}`)}`
                    : ''}
                {(c.changedRows ?? 0) > 0 &&
                  ` · ${t('versions.changedRows', { n: formatNumber(c.changedRows ?? 0, lang) })}`}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {comparison.rules.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('quality.rule')}</TableHead>
              <TableHead className="text-right">
                {t('versions.failedIn', { n: base.versionNo })}
              </TableHead>
              <TableHead className="text-right">
                {t('versions.failedIn', { n: target.versionNo })}
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                {t('quality.passRate')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparison.rules.map((r) => {
              const better =
                r.baseFailed !== null && r.targetFailed !== null && r.targetFailed < r.baseFailed;
              const worse =
                r.baseFailed !== null && r.targetFailed !== null && r.targetFailed > r.baseFailed;
              return (
                <TableRow key={r.ruleId ?? r.ruleName}>
                  <TableCell className="font-medium">{r.ruleName}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {r.baseFailed === null ? '—' : formatNumber(r.baseFailed, lang)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      better && 'text-success font-medium',
                      worse && 'text-destructive font-medium',
                    )}
                  >
                    {r.targetFailed === null ? '—' : formatNumber(r.targetFailed, lang)}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">
                    {r.basePassRate === null ? '—' : formatPercent(r.basePassRate, lang)} →{' '}
                    {r.targetPassRate === null ? '—' : formatPercent(r.targetPassRate, lang)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-xl font-semibold">{children}</div>
    </div>
  );
}
