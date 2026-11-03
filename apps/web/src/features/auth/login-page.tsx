import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequestSchema } from '@insightai/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { authApi } from './auth-api';
import { AuthLayout } from './auth-layout';
import { safeRedirect } from './safe-redirect';
import { useSessionActions } from './use-session';

type LoginForm = z.input<typeof loginRequestSchema>;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirectTo = safeRedirect(params.get('redirectTo'));
  const { signIn } = useSessionActions();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm, unknown, z.output<typeof loginRequestSchema>>({
    resolver: zodResolver(loginRequestSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(await authApi.login(values));
      void navigate(redirectTo, { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 401
          ? t('auth.invalidCredentials')
          : errorMessage(t, error),
      );
    }
  });

  const registerLink = `/register${params.get('redirectTo') ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''}`;

  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to={registerLink} className="text-primary font-medium hover:underline">
            {t('auth.register')}
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
        {formError && <Alert variant="destructive">{formError}</Alert>}
        <Field label={t('auth.email')} error={errors.email && t('validation.email')}>
          <Input type="email" autoComplete="email" autoFocus {...register('email')} />
        </Field>
        <Field label={t('auth.password')} error={errors.password && t('validation.required')}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('auth.loggingIn') : t('auth.login')}
        </Button>
      </form>
    </AuthLayout>
  );
}
