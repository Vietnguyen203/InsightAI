import type { DashboardWidget, SemanticQueryResult } from '@insightai/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { AnswerChart } from '../ask/answer-chart';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { ResultTable } from '../semantic/query-tab';
import { rejectionReason } from '../semantic/semantic-api';
import { dashboardApi } from './dashboard-api';
import { changedVersions, type Move } from './layout';

/** One widget: its data always comes from running the stored query as the current viewer. */
export function WidgetCard({
  widget,
  editing,
  onMove,
  onRemove,
  busy,
}: {
  widget: DashboardWidget;
  editing: boolean;
  onMove: (move: Move) => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const run = useQuery({
    // Keyed by the stored query: moving or resizing does not run it again.
    queryKey: orgKey(organizationId, 'widget-run', widget.id, JSON.stringify(widget.query)),
    queryFn: () => dashboardApi.run(widget.id),
    retry: false,
  });
  const changed = changedVersions(widget, run.data);

  return (
    <article
      className="bg-card flex h-full min-w-0 flex-col gap-3 rounded-xl border p-4"
      aria-label={widget.title}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium">{widget.title}</h3>
        <div className="flex shrink-0 items-center gap-1">
          {changed.length > 0 && (
            <Badge
              variant="outline"
              className="border-warning/40 text-warning"
              title={t('dashboards.definitionChangedHint')}
            >
              {t('dashboards.definitionChanged', {
                versions: changed.map((c) => `v${c.from} → v${c.to}`).join(', '),
              })}
            </Badge>
          )}
          {!editing && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('dashboards.refresh', { title: widget.title })}
              onClick={() => void run.refetch()}
              disabled={run.isFetching}
            >
              <RefreshCw className={cn('size-3.5', run.isFetching && 'animate-spin')} />
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {run.isPending ? (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        ) : run.isError ? (
          <WidgetError error={run.error} />
        ) : (
          <WidgetBody widget={widget} result={run.data} />
        )}
      </div>

      {run.data && run.data.policiesApplied.length > 0 && !editing && (
        <p className="text-muted-foreground text-xs">{t('dashboards.filteredForYou')}</p>
      )}

      {editing && (
        <footer
          className="flex flex-wrap items-center gap-1 border-t pt-2"
          aria-label={t('dashboards.widgetControls', { title: widget.title })}
        >
          <IconButton label={t('dashboards.moveLeft')} onClick={() => onMove('left')} busy={busy}>
            <ArrowLeft />
          </IconButton>
          <IconButton label={t('dashboards.moveRight')} onClick={() => onMove('right')} busy={busy}>
            <ArrowRight />
          </IconButton>
          <IconButton label={t('dashboards.moveUp')} onClick={() => onMove('up')} busy={busy}>
            <ArrowUp />
          </IconButton>
          <IconButton label={t('dashboards.moveDown')} onClick={() => onMove('down')} busy={busy}>
            <ArrowDown />
          </IconButton>
          <span className="text-muted-foreground mx-1 flex items-center" aria-hidden>
            <MoveHorizontal className="size-3.5" />
          </span>
          <IconButton
            label={t('dashboards.narrower')}
            onClick={() => onMove('narrower')}
            busy={busy}
          >
            <Minus />
          </IconButton>
          <IconButton label={t('dashboards.wider')} onClick={() => onMove('wider')} busy={busy}>
            <Plus />
          </IconButton>
          <span className="text-muted-foreground mx-1 flex items-center" aria-hidden>
            <MoveVertical className="size-3.5" />
          </span>
          <IconButton label={t('dashboards.shorter')} onClick={() => onMove('shorter')} busy={busy}>
            <Minus />
          </IconButton>
          <IconButton label={t('dashboards.taller')} onClick={() => onMove('taller')} busy={busy}>
            <Plus />
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive ml-auto"
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 />
            {t('common.remove')}
          </Button>
        </footer>
      )}
    </article>
  );
}

function IconButton({
  label,
  onClick,
  busy,
  children,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-7 [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function WidgetBody({ widget, result }: { widget: DashboardWidget; result: SemanticQueryResult }) {
  const { t } = useTranslation();
  if (result.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('semantic.noRows')}</p>;
  }
  if (widget.chart.type === 'table') return <ResultTable result={result} />;
  return <AnswerChart spec={widget.chart} result={result} />;
}

/** Rejected queries mean the widget needs updating (a member or metric changed or is hidden). */
function WidgetError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const reason = rejectionReason(error);
  if (error instanceof ApiError && error.status === 422) {
    const hidden = reason === 'UNKNOWN_MEMBER' || reason === 'UNKNOWN_METRIC';
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {hidden ? t('dashboards.notAvailable') : t('dashboards.needsUpdate')}
        </p>
        <p className="text-muted-foreground">
          {reason
            ? t(`semantic.reasons.${reason}`, { defaultValue: errorMessage(t, error) })
            : errorMessage(t, error)}
        </p>
      </div>
    );
  }
  return <p className="text-destructive text-sm">{errorMessage(t, error)}</p>;
}
