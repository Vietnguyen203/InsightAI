import { zodResolver } from '@hookform/resolvers/zod';
import { createOrganizationRequestSchema } from '@insightai/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { setActiveOrganizationId } from '@/lib/session';
import { ME_QUERY_KEY } from '../auth/use-session';
import { organizationsApi } from './organizations-api';

type CreateForm = z.input<typeof createOrganizationRequestSchema>;

export function CreateOrganizationForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateForm>({ resolver: zodResolver(createOrganizationRequestSchema) });

  const create = useMutation({
    mutationFn: (name: string) => organizationsApi.create(name),
    onSuccess: async (organization) => {
      setActiveOrganizationId(organization.id);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void navigate('/', { replace: true });
    },
  });

  return (
    <form
      onSubmit={(e) => void handleSubmit((values) => create.mutate(values.name))(e)}
      className="grid gap-4"
      noValidate
    >
      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
      <Field
        label={t('auth.organizationName')}
        error={errors.name && t('validation.name')}
        hint={t('auth.organizationNameHint')}
      >
        <Input autoFocus {...register('name')} />
      </Field>
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? t('onboarding.creating') : t('onboarding.create')}
      </Button>
    </form>
  );
}
