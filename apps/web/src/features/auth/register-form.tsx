import { zodResolver } from '@hookform/resolvers/zod';
import { emailSchema, passwordSchema } from '@insightai/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { authApi } from './auth-api';
import { useSessionActions } from './use-session';

const baseSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
});
const withOrganizationSchema = baseSchema.extend({
  organizationName: z.string().trim().min(2).max(120),
});

type RegisterForm = z.input<typeof withOrganizationSchema>;

/**
 * Registration form shared by the register page (creates an organization) and the invite page
 * (joins the inviting organization, so no organization name is asked).
 */
export function RegisterForm({
  invitationToken,
  onRegistered,
}: {
  invitationToken?: string;
  onRegistered: () => void;
}) {
  const { t } = useTranslation();
  const { signIn } = useSessionActions();
  const [formError, setFormError] = useState<string | null>(null);
  const schema = invitationToken ? baseSchema : withOrganizationSchema;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({ resolver: zodResolver(schema as typeof withOrganizationSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const auth = await authApi.register(
        invitationToken
          ? {
              email: values.email,
              password: values.password,
              fullName: values.fullName,
              invitationToken,
            }
          : values,
      );
      await signIn(auth);
      onRegistered();
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 409
          ? t('auth.emailTaken')
          : errorMessage(t, error),
      );
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field label={t('auth.fullName')} error={errors.fullName && t('validation.required')}>
        <Input autoComplete="name" autoFocus {...register('fullName')} />
      </Field>
      <Field label={t('auth.email')} error={errors.email && t('validation.email')}>
        <Input type="email" autoComplete="email" {...register('email')} />
      </Field>
      <Field
        label={t('auth.password')}
        error={errors.password && t('validation.password')}
        hint={t('auth.passwordHint')}
      >
        <Input type="password" autoComplete="new-password" {...register('password')} />
      </Field>
      {!invitationToken && (
        <Field
          label={t('auth.organizationName')}
          error={errors.organizationName && t('validation.name')}
          hint={t('auth.organizationNameHint')}
        >
          <Input autoComplete="organization" {...register('organizationName')} />
        </Field>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('auth.registering') : t('auth.register')}
      </Button>
    </form>
  );
}
