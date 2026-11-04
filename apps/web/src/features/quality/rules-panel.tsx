import { type DatasetColumn, Permission, type QualityRule } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { describeRule } from './describe';
import { qualityApi } from './quality-api';
import { SeverityBadge } from './quality-badges';
import { RuleEditor } from './rule-editor';

/** Rules of the dataset. They apply to every version; changes take effect at the next check. */
export function RulesPanel({
  datasetId,
  columns,
}: {
  datasetId: string;
  columns: DatasetColumn[];
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.QUALITY_WRITE);
  const key = orgKey(organizationId, 'dataset', datasetId, 'quality-rules');
  const [editing, setEditing] = useState<QualityRule | 'new' | null>(null);

  const rules = useQuery({ queryKey: key, queryFn: () => qualityApi.rules(datasetId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const toggle = useMutation({
    mutationFn: (rule: QualityRule) => qualityApi.updateRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (rule: QualityRule) => qualityApi.deleteRule(rule.id),
    onSuccess: refresh,
  });

  return (
    <section className="space-y-4" aria-labelledby="quality-rules">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="quality-rules" className="text-lg font-semibold">
            {t('quality.rules')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('quality.rulesHint')}</p>
        </div>
        {canWrite && editing === null && (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus />
            {t('quality.addRule')}
          </Button>
        )}
      </div>

      {editing !== null && (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          datasetId={datasetId}
          columns={columns}
          rule={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}

      {(toggle.isError || remove.isError) && (
        <Alert variant="destructive">{errorMessage(t, toggle.error ?? remove.error)}</Alert>
      )}
      {rules.isError ? (
        <Alert variant="destructive">{errorMessage(t, rules.error)}</Alert>
      ) : !rules.data ? (
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('quality.rule')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('quality.dimensionLabel')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('quality.severityLabel')}</TableHead>
              <TableHead className="hidden text-right lg:table-cell">
                {t('quality.thresholdLabel')}
              </TableHead>
              <TableHead>{t('quality.enabled')}</TableHead>
              {canWrite && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data.map((rule) => (
              <TableRow key={rule.id} className={cn(!rule.enabled && 'opacity-60')}>
                <TableCell className="max-w-md">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {rule.name}
                    {rule.origin === 'system' && (
                      <Badge variant="secondary">{t('quality.systemRule')}</Badge>
                    )}
                  </div>
                  <div
                    className="text-muted-foreground truncate text-xs"
                    title={describeRule(t, rule.definition)}
                  >
                    {describeRule(t, rule.definition)}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground hidden md:table-cell">
                  {t(`quality.dimension.${rule.dimension}`)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <SeverityBadge severity={rule.severity} />
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-right tabular-nums lg:table-cell">
                  {formatPercent(rule.threshold, i18n.language)}
                </TableCell>
                <TableCell>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={!canWrite || toggle.isPending}
                      onChange={() => toggle.mutate(rule)}
                      aria-label={t('quality.toggleRule', { rule: rule.name })}
                    />
                    <span className="sr-only sm:not-sr-only">
                      {rule.enabled ? t('quality.on') : t('quality.off')}
                    </span>
                  </label>
                </TableCell>
                {canWrite && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t('quality.editRule', { rule: rule.name })}
                        onClick={() => setEditing(rule)}
                      >
                        <Pencil />
                      </Button>
                      {rule.origin === 'user' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive size-8"
                          aria-label={t('quality.deleteRule', { rule: rule.name })}
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(t('quality.deleteConfirm', { rule: rule.name })))
                              remove.mutate(rule);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
