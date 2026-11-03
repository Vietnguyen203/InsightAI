import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from './auth-layout';
import { safeRedirect } from './safe-redirect';
import { RegisterForm } from './register-form';

export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirectTo = safeRedirect(params.get('redirectTo'));

  return (
    <AuthLayout
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="text-primary font-medium hover:underline">
            {t('auth.login')}
          </Link>
        </>
      }
    >
      <RegisterForm onRegistered={() => void navigate(redirectTo, { replace: true })} />
    </AuthLayout>
  );
}
