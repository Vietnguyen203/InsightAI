import { zodResolver } from '@hookform/resolvers/zod';
import { createDatasetRequestSchema, Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { PageHeader, Section } from '../settings/page-header';
import { datasetsApi, isInProgress } from './datasets-api';
import { DatasetStatusBadge, ImportStatusBadge } from './status-badges';

type CreateForm = z.input<typeof createDatasetRequestSchema>;

export function DatasetListPage() {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.DATASET_WRITE);
  const [creating, setCreating] = useState(false);

  const datasets = useQuery({
    queryKey: orgKey(organizationId, 'datasets'),
    queryFn: datasetsApi.list,
    // Keep import badges current while something is processing.
    refetchInterval: (query) =>
      query.state.data?.some((d) => isInProgress(d.latestImport?.status)) ? 3000 : false,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('datasets.title')}
        description={t('datasets.description')}
        actions={
          canWrite && !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              {t('datasets.create')}
            </Button>
          ) : undefined
        }
      />

      {creating && <CreateDatasetForm onCancel={() => setCreating(false)} />}

      <Section title={t('datasets.title')}>
        {datasets.isError && <Alert variant="destructive">{errorMessage(t, datasets.error)}</Alert>}
        {datasets.isPending && (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        )}
        {datasets.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('datasets.empty')}</p>
        )}
        {datasets.data && datasets.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('datasets.columns.name')}</TableHead>
                <TableHead className="text-right">{t('datasets.columns.rows')}</TableHead>
                <TableHead className="text-right">{t('datasets.columns.cols')}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t('datasets.columns.lastImport')}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t('datasets.columns.updated')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {datasets.data.map((dataset) => (
                <TableRow key={dataset.id}>
                  <TableCell>
                    <Link to={`/datasets/${dataset.id}`} className="font-medium hover:underline">
                      {dataset.name}
                    </Link>
                    <div className="mt-1">
                      <DatasetStatusBadge status={dataset.status} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {dataset.activeVersion
                      ? formatNumber(dataset.activeVersion.rowCount, i18n.language)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {dataset.columnCount ?? '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {dataset.latestImport ? (
                      <ImportStatusBadge status={dataset.latestImport.status} />
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell">
                    {formatDateTime(dataset.updatedAt, i18n.language)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function CreateDatasetForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateForm>({ resolver: zodResolver(createDatasetRequestSchema) });

  const create = useMutation({
    mutationFn: datasetsApi.create,
    onSuccess: async (dataset) => {
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'datasets') });
      void navigate(`/datasets/${dataset.id}`);
    },
  });

  return (
    <Section title={t('datasets.create')}>
      <form
        className="grid gap-4 md:grid-cols-[1fr_2fr_auto]"
        noValidate
        onSubmit={(e) => void handleSubmit((values) => create.mutate(values))(e)}
      >
        <Field label={t('datasets.name')} error={errors.name && t('validation.required')}>
          <Input autoFocus {...register('name')} />
        </Field>
        <Field label={t('datasets.descriptionLabel')}>
          <Input {...register('description')} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('datasets.creating') : t('datasets.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
    </Section>
  );
}
