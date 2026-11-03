import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AuthLayout } from '../auth/auth-layout';
import { useSessionActions } from '../auth/use-session';
import { CreateOrganizationForm } from './create-organization-form';

/** Shown to signed-in users without any organization (e.g. removed from their only one). */
export function OnboardingPage() {
  const { t } = useTranslation();
  const { signOut } = useSessionActions();
  return (
    <AuthLayout
      title={t('onboarding.title')}
      subtitle={t('onboarding.description')}
      footer={
        <Button variant="link" className="h-auto p-0" onClick={() => void signOut()}>
          {t('auth.logout')}
        </Button>
      }
    >
      <CreateOrganizationForm />
    </AuthLayout>
  );
}

export function NewOrganizationPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.title')}</h1>
      </div>
      <div className="bg-card rounded-xl border p-6">
        <CreateOrganizationForm />
      </div>
    </div>
  );
}
