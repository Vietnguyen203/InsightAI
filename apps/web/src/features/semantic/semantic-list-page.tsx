import { zodResolver } from '@hookform/resolvers/zod';
import {
  createSemanticModelRequestSchema,
  Permission,
  type SemanticValidationStatus,
} from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage, fieldErrors } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { PageHeader, Section } from '../settings/page-header';
import { semanticApi } from './semantic-api';

type CreateForm = z.input<typeof createSemanticModelRequestSchema>;

export function SemanticListPage() {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const [creating, setCreating] = useState(false);
  const models = useQuery({
    queryKey: orgKey(organizationId, 'semantic-models'),
    queryFn: semanticApi.models,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('semantic.title')}
        description={t('semantic.description')}
        actions={
          canWrite && !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              {t('semantic.create')}
            </Button>
          ) : undefined
        }
      />
      {creating && <CreateModelForm onCancel={() => setCreating(false)} />}

      {models.isError && <Alert variant="destructive">{errorMessage(t, models.error)}</Alert>}
      {models.isPending && <p className="text-muted-foreground text-sm">{t('common.loading')}</p>}
      {models.data?.length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
          {t('semantic.empty')}
        </p>
      )}
      {models.data && models.data.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {models.data.map((model) => (
            <li key={model.id}>
              <Link
                to={`/semantic/${model.id}`}
                className="bg-card hover:border-primary/50 flex h-full flex-col gap-3 rounded-xl border p-5 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{model.name}</h2>
                    <p className="text-muted-foreground font-mono text-xs">{model.key}</p>
                  </div>
                  <ModelStatusBadge status={model.status} revision={model.revision} />
                </div>
                {model.description && (
                  <p className="text-muted-foreground line-clamp-2 text-sm">{model.description}</p>
                )}
                <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-2 text-xs">
                  <span>{t('semantic.entityCount', { count: model.entityCount })}</span>
                  <span>·</span>
                  <ValidationBadge status={model.validationStatus} />
                  {model.hasDraftChanges && model.status === 'PUBLISHED' && (
                    <Badge variant="outline">{t('semantic.draftChanges')}</Badge>
                  )}
                  <span className="ml-auto">{formatDateTime(model.updatedAt, i18n.language)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateModelForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateForm>({ resolver: zodResolver(createSemanticModelRequestSchema) });
  const create = useMutation({
    mutationFn: semanticApi.createModel,
    onSuccess: async (model) => {
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'semantic-models') });
      void navigate(`/semantic/${model.id}`);
    },
  });
  const server = fieldErrors(create.error);

  return (
    <Section title={t('semantic.create')}>
      <form
        className="grid gap-4 md:grid-cols-[1fr_1fr_2fr_auto]"
        noValidate
        onSubmit={(e) => void handleSubmit((values) => create.mutate(values))(e)}
      >
        <Field label={t('semantic.name')} error={errors.name && t('validation.required')}>
          <Input autoFocus {...register('name')} />
        </Field>
        <Field
          label={t('semantic.key')}
          hint={t('semantic.keyHint')}
          error={errors.key ? t('semantic.keyInvalid') : server.key}
        >
          <Input className="font-mono" placeholder="sales" {...register('key')} />
        </Field>
        <Field label={t('semantic.descriptionLabel')}>
          <Input {...register('description')} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={create.isPending}>
            {t('semantic.create')}
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

export function ModelStatusBadge({
  status,
  revision,
}: {
  status: 'DRAFT' | 'PUBLISHED';
  revision: number;
}) {
  const { t } = useTranslation();
  return (
    <Badge variant={status === 'PUBLISHED' ? 'success' : 'secondary'}>
      {status === 'PUBLISHED' ? t('semantic.published', { revision }) : t('semantic.status.DRAFT')}
    </Badge>
  );
}

export function ValidationBadge({ status }: { status: SemanticValidationStatus }) {
  const { t } = useTranslation();
  const variant = {
    UNVALIDATED: 'secondary',
    VALID: 'success',
    WARNING: 'outline',
    INVALID: 'destructive',
  } as const;
  return (
    <Badge
      variant={variant[status]}
      className={cn(status === 'WARNING' && 'border-warning/40 text-warning')}
    >
      {t(`semantic.validation.${status}`)}
    </Badge>
  );
}
