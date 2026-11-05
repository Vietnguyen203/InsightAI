import { zodResolver } from '@hookform/resolvers/zod';
import { type CurrentOrganization, Permission } from '@insightai/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { ME_QUERY_KEY } from '../auth/use-session';
import { organizationsApi } from '../organizations/organizations-api';
import { orgKey, useCurrentOrganization, usePermission } from '../organizations/use-organization';
import { PageHeader, Section } from './page-header';

const formSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().min(1),
  locale: z.enum(['vi', 'en']),
  aiDataSharing: z.enum(['METADATA_ONLY', 'FULL']),
});
type OrganizationForm = z.infer<typeof formSchema>;

export function OrganizationSettingsPage() {
  const { t } = useTranslation();
  const { data: organization } = useCurrentOrganization();
  if (!organization) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  return <OrganizationSettingsForm organization={organization} />;
}

function OrganizationSettingsForm({ organization }: { organization: CurrentOrganization }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermission(Permission.ORG_UPDATE);
  // ICU lists some zones under legacy ids (Asia/Saigon), so always offer the current value too.
  const timezones = useMemo(
    () => [...new Set([organization.timezone, ...Intl.supportedValuesOf('timeZone')])].sort(),
    [organization.timezone],
  );

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<OrganizationForm>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: organization.name,
      timezone: organization.timezone,
      locale: organization.locale === 'en' ? 'en' : 'vi',
      aiDataSharing: organization.aiDataSharing,
    },
  });

  const save = useMutation({
    mutationFn: organizationsApi.update,
    onSuccess: async (updated) => {
      reset({
        name: updated.name,
        timezone: updated.timezone,
        locale: updated.locale === 'en' ? 'en' : 'vi',
        aiDataSharing: updated.aiDataSharing,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey(organization.id, 'current') }),
        queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }), // organization name in switcher
      ]);
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={t('settings.organization.title')}
        description={t('settings.organization.description')}
      />
      <Section title={organization.name}>
        {!canEdit && <Alert>{t('settings.organization.readOnly')}</Alert>}
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => void handleSubmit((values) => save.mutate(values))(e)}
        >
          <fieldset disabled={!canEdit || save.isPending} className="grid gap-4">
            <Field
              label={t('settings.organization.name')}
              error={errors.name && t('validation.name')}
            >
              <Input {...register('name')} />
            </Field>
            <Field
              label={t('settings.organization.timezone')}
              hint={t('settings.organization.timezoneHint')}
            >
              <NativeSelect {...register('timezone')}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('settings.organization.locale')}>
              <NativeSelect {...register('locale')}>
                <option value="vi">{t('language.vi')}</option>
                <option value="en">{t('language.en')}</option>
              </NativeSelect>
            </Field>
            <Field
              label={t('settings.organization.aiDataSharing')}
              hint={t('settings.organization.aiDataSharingHint')}
            >
              <NativeSelect {...register('aiDataSharing')}>
                <option value="METADATA_ONLY">
                  {t('settings.organization.aiDataSharingOptions.METADATA_ONLY')}
                </option>
                <option value="FULL">{t('settings.organization.aiDataSharingOptions.FULL')}</option>
              </NativeSelect>
            </Field>
            <Field label={t('settings.organization.currency')}>
              <Input value={organization.defaultCurrency} readOnly disabled />
            </Field>
          </fieldset>
          {save.isError && <Alert variant="destructive">{errorMessage(t, save.error)}</Alert>}
          {save.isSuccess && !isDirty && <Alert variant="success">{t('common.saved')}</Alert>}
          {canEdit && (
            <div>
              <Button type="submit" disabled={!isDirty || save.isPending}>
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          )}
        </form>
      </Section>
    </div>
  );
}
