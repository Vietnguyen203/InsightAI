import {
  type CleaningOperationInput,
  type CleaningPreview,
  type CleaningSuggestion,
  type DatasetVersion,
  Permission,
} from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, Plus, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { errorMessage, fieldErrors } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { datasetsApi } from '../datasets/datasets-api';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { describeOperation } from './describe';
import { OperationEditor } from './operation-editor';
import { isRunning, qualityApi } from './quality-api';
import { JobStatusBadge } from './quality-badges';
import { columnsAfter } from './step-columns';

interface RecipeStep {
  key: string;
  operation: CleaningOperationInput;
  suggestionId?: string;
}

let nextKey = 0;
const step = (operation: CleaningOperationInput, suggestionId?: string): RecipeStep => ({
  key: `op-${(nextKey += 1)}`,
  operation,
  ...(suggestionId ? { suggestionId } : {}),
});

/**
 * Cleaning wizard: pick operations (from suggestions or by hand) → preview the exact impact →
 * apply as a new version. The source version is never modified.
 */
export function CleaningTab({
  datasetId,
  versions,
  activeVersionId,
  onOpenVersions,
}: {
  datasetId: string;
  versions: DatasetVersion[];
  activeVersionId: string;
  onOpenVersions: (versionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canPreview = usePermission(Permission.QUALITY_WRITE);
  const canApply = usePermission(Permission.QUALITY_APPLY_CLEANING);

  const [sourceVersionId, setSourceVersionId] = useState(activeVersionId);
  const [recipe, setRecipe] = useState<RecipeStep[]>([]);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<CleaningPreview | null>(null);
  const [appliedJobId, setAppliedJobId] = useState<string | null>(null);

  const operations = recipe.map((s) => s.operation);
  const setSteps = (next: RecipeStep[]) => {
    setRecipe(next);
    setPreview(null); // a preview only describes the recipe it was computed for
  };

  const sourceColumns = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'columns', sourceVersionId),
    queryFn: async () =>
      (await datasetsApi.rows(datasetId, { versionId: sourceVersionId, limit: 1 })).columns,
  });
  const suggestions = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'cleaning-suggestions', sourceVersionId),
    queryFn: () => qualityApi.suggestions(datasetId, sourceVersionId),
  });
  const rules = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'quality-rules'),
    queryFn: () => qualityApi.rules(datasetId),
  });
  const jobsKey = orgKey(organizationId, 'dataset', datasetId, 'cleaning-jobs');
  const jobs = useQuery({
    queryKey: jobsKey,
    queryFn: () => qualityApi.cleaningJobs(datasetId),
    refetchInterval: (query) => (query.state.data?.some((j) => isRunning(j.status)) ? 2000 : false),
  });

  const runPreview = useMutation({
    mutationFn: () => qualityApi.preview(datasetId, { sourceVersionId, operations }),
    onSuccess: setPreview,
  });
  const apply = useMutation({
    mutationFn: () => qualityApi.apply(datasetId, { sourceVersionId, operations }),
    onSuccess: async (job) => {
      setAppliedJobId(job.id);
      setSteps([]);
      await queryClient.invalidateQueries({ queryKey: jobsKey });
    },
  });

  // When a job finishes, the dataset gets a new version: refresh the header and versions.
  // Until the job list is refetched, show the job returned by the apply request.
  const appliedJob =
    jobs.data?.find((j) => j.id === appliedJobId) ??
    (apply.data?.id === appliedJobId ? apply.data : undefined);
  const finishedJobId = appliedJob && !isRunning(appliedJob.status) ? appliedJob.id : null;
  useEffect(() => {
    if (finishedJobId) {
      void queryClient.invalidateQueries({
        queryKey: orgKey(organizationId, 'dataset', datasetId),
      });
    }
  }, [finishedJobId, queryClient, organizationId, datasetId]);

  const stepColumns = sourceColumns.data ? columnsAfter(sourceColumns.data, operations) : [];
  const failingStep = (() => {
    const errors = fieldErrors(runPreview.error ?? apply.error);
    const path = Object.keys(errors).find((p) => p.startsWith('operations.'));
    return path ? Number(path.split('.')[1]) : null;
  })();
  const ruleNames = new Map((rules.data ?? []).map((r) => [r.id, r.name]));
  const added = new Set(recipe.flatMap((s) => (s.suggestionId ? [s.suggestionId] : [])));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="cleaning-source">
          {t('cleaning.source')}
        </label>
        <NativeSelect
          id="cleaning-source"
          className="h-8 w-auto"
          value={sourceVersionId}
          onChange={(e) => {
            setSourceVersionId(e.target.value);
            setSteps([]);
          }}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {t('cleaning.versionOption', {
                n: v.versionNo,
                origin: t(`versions.origin.${v.origin}`),
                rows: formatNumber(v.rowCount, lang),
              })}
              {v.id === activeVersionId ? ` · ${t('versions.active')}` : ''}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">{t('cleaning.sourceHint')}</p>
      </div>

      {appliedJob && (
        <AppliedJob
          job={appliedJob}
          onOpen={() => appliedJob.targetVersionId && onOpenVersions(appliedJob.targetVersionId)}
          onDismiss={() => setAppliedJobId(null)}
        />
      )}

      <section className="space-y-3" aria-labelledby="cleaning-suggestions">
        <div className="flex items-center gap-2">
          <Sparkles className="text-primary size-4" aria-hidden />
          <h2 id="cleaning-suggestions" className="text-lg font-semibold">
            {t('cleaning.suggestions')}
          </h2>
        </div>
        {suggestions.isError ? (
          <Alert variant="destructive">{errorMessage(t, suggestions.error)}</Alert>
        ) : !suggestions.data ? (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        ) : suggestions.data.suggestions.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
            {suggestions.data.qualityCheckId
              ? t('cleaning.noSuggestions')
              : t('cleaning.noCheckYet')}
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {suggestions.data.suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                added={added.has(s.id)}
                ruleNames={ruleNames}
                canAdd={canPreview}
                onAdd={() => setSteps([...recipe, step(s.operation, s.id)])}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="cleaning-recipe">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="cleaning-recipe" className="text-lg font-semibold">
              {t('cleaning.recipe')}
            </h2>
            <p className="text-muted-foreground text-sm">{t('cleaning.recipeHint')}</p>
          </div>
          {canPreview && !adding && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
              disabled={!sourceColumns.data}
            >
              <Plus />
              {t('cleaning.addOperation')}
            </Button>
          )}
        </div>

        {recipe.length === 0 && !adding ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
            {t('cleaning.emptyRecipe')}
          </p>
        ) : (
          <ol className="space-y-2">
            {recipe.map((s, index) => {
              const impact = preview?.operations[index];
              return (
                <li
                  key={s.key}
                  className={cn(
                    'bg-card flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2',
                    failingStep === index && 'border-destructive',
                  )}
                >
                  <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {t(`cleaning.opType.${s.operation.type}`)}
                    </div>
                    <div
                      className="text-muted-foreground truncate text-xs"
                      title={describeOperation(t, s.operation, ruleNames)}
                    >
                      {describeOperation(t, s.operation, ruleNames)}
                    </div>
                  </div>
                  {impact && (
                    <Badge
                      variant={impact.affectedRows || impact.removedRows ? 'default' : 'secondary'}
                    >
                      {impact.removedRows > 0
                        ? t('cleaning.removesRows', {
                            count: impact.removedRows,
                            n: formatNumber(impact.removedRows, lang),
                          })
                        : impact.affectedRows === null
                          ? t('cleaning.schemaChange')
                          : t('cleaning.changesRows', {
                              count: impact.affectedRows,
                              n: formatNumber(impact.affectedRows, lang),
                            })}
                    </Badge>
                  )}
                  {canPreview && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t('cleaning.moveUp')}
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...recipe];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          setSteps(next);
                        }}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t('cleaning.moveDown')}
                        disabled={index === recipe.length - 1}
                        onClick={() => {
                          const next = [...recipe];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          setSteps(next);
                        }}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive size-7"
                        aria-label={t('cleaning.removeStep', { n: index + 1 })}
                        onClick={() => setSteps(recipe.filter((x) => x.key !== s.key))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {adding && (
          <OperationEditor
            columns={stepColumns}
            rules={rules.data ?? []}
            onCancel={() => setAdding(false)}
            onAdd={(operation) => {
              setSteps([...recipe, step(operation)]);
              setAdding(false);
            }}
          />
        )}

        {(runPreview.isError || apply.isError) && (
          <Alert variant="destructive">{errorMessage(t, runPreview.error ?? apply.error)}</Alert>
        )}

        {recipe.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {canPreview && (
              <Button
                variant="outline"
                onClick={() => runPreview.mutate()}
                disabled={runPreview.isPending}
              >
                <Eye />
                {runPreview.isPending ? t('cleaning.previewing') : t('cleaning.preview')}
              </Button>
            )}
            {canApply && (
              <Button
                disabled={!preview || apply.isPending}
                onClick={() => {
                  if (window.confirm(t('cleaning.applyConfirm'))) apply.mutate();
                }}
              >
                <Wand2 />
                {t('cleaning.apply')}
              </Button>
            )}
          </div>
        )}
        {recipe.length > 0 && canApply && !preview && (
          <p className="text-muted-foreground text-right text-xs">{t('cleaning.previewFirst')}</p>
        )}
      </section>

      {preview && <PreviewPanel preview={preview} />}

      <section className="space-y-3" aria-labelledby="cleaning-history">
        <h2 id="cleaning-history" className="text-lg font-semibold">
          {t('cleaning.history')}
        </h2>
        {jobs.isError ? (
          <Alert variant="destructive">{errorMessage(t, jobs.error)}</Alert>
        ) : !jobs.data ? (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        ) : jobs.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('cleaning.noHistory')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('cleaning.when')}</TableHead>
                <TableHead>{t('cleaning.fromVersion')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('cleaning.operations')}</TableHead>
                <TableHead>{t('cleaning.status')}</TableHead>
                <TableHead className="text-right">{t('cleaning.result')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.data.map((job) => {
                const target = versions.find((v) => v.id === job.targetVersionId);
                return (
                  <TableRow key={job.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {formatDateTime(job.createdAt, lang)}
                    </TableCell>
                    <TableCell>{t('datasets.versionLabel', { n: job.sourceVersionNo })}</TableCell>
                    <TableCell className="hidden max-w-md md:table-cell">
                      <ul className="text-muted-foreground space-y-0.5 text-xs">
                        {job.operations.map((op) => (
                          <li
                            key={op.seq}
                            className="truncate"
                            title={describeOperation(t, op.operation, ruleNames)}
                          >
                            {op.seq + 1}. {describeOperation(t, op.operation, ruleNames)}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                      {job.error && (
                        <div className="text-destructive mt-1 max-w-56 text-xs">
                          {t(`cleaning.errors.${job.error.code}`, {
                            defaultValue: job.error.message,
                          })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {target ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() => onOpenVersions(target.id)}
                        >
                          {t('datasets.versionLabel', { n: target.versionNo })}
                        </Button>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  added,
  ruleNames,
  canAdd,
  onAdd,
}: {
  suggestion: CleaningSuggestion;
  ruleNames: ReadonlyMap<string, string>;
  added: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { code, message, params } = suggestion.rationale;
  return (
    <li className="bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {t(`cleaning.opType.${suggestion.operation.type}`)}
          </span>
          {suggestion.estimatedRows !== null && (
            <Badge variant="secondary">
              {t('cleaning.estimatedRows', {
                n: formatNumber(suggestion.estimatedRows, i18n.language),
              })}
            </Badge>
          )}
        </div>
        <p className="text-sm">
          {t(`cleaning.rationale.${code}`, { ...params, defaultValue: message })}
        </p>
        <p
          className="text-muted-foreground truncate text-xs"
          title={describeOperation(t, suggestion.operation, ruleNames)}
        >
          {describeOperation(t, suggestion.operation, ruleNames)}
        </p>
      </div>
      {canAdd && (
        <Button
          size="sm"
          variant={added ? 'secondary' : 'outline'}
          className="self-start"
          disabled={added}
          onClick={onAdd}
        >
          {added ? t('cleaning.added') : t('cleaning.addToRecipe')}
        </Button>
      )}
    </li>
  );
}

function PreviewPanel({ preview }: { preview: CleaningPreview }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const changedColumns = preview.columns.filter((c) => c.status !== 'unchanged');
  const removed = preview.rowCountBefore - preview.rowCountAfter;

  return (
    <section className="space-y-4" aria-labelledby="cleaning-preview">
      <h2 id="cleaning-preview" className="text-lg font-semibold">
        {t('cleaning.previewTitle')}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('cleaning.rowsBefore')} value={formatNumber(preview.rowCountBefore, lang)} />
        <Stat label={t('cleaning.rowsAfter')} value={formatNumber(preview.rowCountAfter, lang)} />
        <Stat
          label={t('cleaning.rowsRemoved')}
          value={formatNumber(removed, lang)}
          tone={removed > 0 ? 'destructive' : undefined}
        />
      </div>

      {changedColumns.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {changedColumns.map((c) => (
            <Badge
              key={`${c.previousName ?? c.name}`}
              variant={c.status === 'removed' ? 'destructive' : 'outline'}
            >
              {c.status === 'renamed'
                ? t('cleaning.columnRenamed', { from: c.previousName, to: c.name })
                : c.status === 'removed'
                  ? t('cleaning.columnRemoved', { name: c.name })
                  : c.previousType
                    ? t('cleaning.columnRetyped', {
                        name: c.name,
                        from: t(`datasets.types.${c.previousType}`),
                        to: t(`datasets.types.${c.dataType}`),
                      })
                    : t('cleaning.columnModified', { name: c.name })}
            </Badge>
          ))}
        </div>
      )}

      {preview.sample.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('cleaning.noChanges')}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {t('cleaning.sampleHint', { n: preview.sample.rows.length })}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-muted-foreground text-left text-xs">
                  <th className="px-3 py-2 font-medium">{t('quality.rowId')}</th>
                  {preview.sample.columns.map((name) => (
                    <th key={name} className="px-3 py-2 font-mono font-medium">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.rows.map((row) => (
                  <tr key={row.rowId} className={cn('border-t', row.removed && 'bg-destructive/5')}>
                    <td className="text-muted-foreground px-3 py-1.5 align-top tabular-nums">
                      #{row.rowId}
                      {row.removed && (
                        <div className="text-destructive text-xs">{t('cleaning.removed')}</div>
                      )}
                    </td>
                    {row.before.map((before, i) => {
                      const after = row.after?.[i] ?? null;
                      const changed = !row.removed && before !== after;
                      return (
                        <td key={i} className="px-3 py-1.5 align-top">
                          {changed ? (
                            <div className="space-y-0.5">
                              <div className="text-muted-foreground line-through decoration-1">
                                <Cell value={before} />
                              </div>
                              <div className="text-success font-medium">
                                <Cell value={after} />
                              </div>
                            </div>
                          ) : (
                            <span
                              className={cn(row.removed && 'text-muted-foreground line-through')}
                            >
                              <Cell value={before} />
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Cell({ value }: { value: string | null }) {
  const { t } = useTranslation();
  if (value === null)
    return <span className="text-muted-foreground italic">{t('quality.empty')}</span>;
  // Make leading/trailing spaces visible.
  return <span className="whitespace-pre">{value === '' ? '""' : value}</span>;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'destructive' | undefined;
}) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function AppliedJob({
  job,
  onOpen,
  onDismiss,
}: {
  job: {
    status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    error: { code: string; message: string } | null;
    targetVersionId: string | null;
  };
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const variant =
    job.status === 'SUCCEEDED' ? 'success' : job.status === 'FAILED' ? 'destructive' : 'default';
  return (
    <Alert variant={variant} className="flex flex-wrap items-center justify-between gap-3">
      <span>
        {isRunning(job.status)
          ? t('cleaning.applying')
          : job.status === 'SUCCEEDED'
            ? t('cleaning.applied')
            : t(`cleaning.errors.${job.error?.code ?? 'INTERNAL_ERROR'}`, {
                defaultValue: job.error?.message ?? '',
              })}
      </span>
      <div className="flex items-center gap-2">
        {job.status === 'SUCCEEDED' && job.targetVersionId && (
          <Button size="sm" variant="outline" onClick={onOpen}>
            {t('cleaning.reviewVersion')}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t('common.close')}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
    </Alert>
  );
}
