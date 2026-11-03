import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { setActiveOrganizationId } from '@/lib/session';
import { authApi } from './auth-api';
import { AuthLayout } from './auth-layout';
import { RegisterForm } from './register-form';
import { ME_QUERY_KEY, useSession } from './use-session';

export function InvitePage() {
  const { t, i18n } = useTranslation();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => authApi.previewInvitation(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => authApi.acceptInvitation(token),
    onSuccess: async (membership) => {
      setActiveOrganizationId(membership.organizationId);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void navigate('/', { replace: true });
    },
  });

  if (preview.isPending || session.status === 'unknown') {
    return <AuthLayout title={t('invite.title')}>{t('common.loading')}</AuthLayout>;
  }
  if (preview.isError) {
    return (
      <AuthLayout title={t('invite.title')}>
        <Alert variant="destructive">{t('invite.invalid')}</Alert>
      </AuthLayout>
    );
  }

  const { organizationName, role, expiresAt } = preview.data;
  const description = (
    <>
      <p>{t('invite.description', { organization: organizationName, role: t(`roles.${role}`) })}</p>
      <p className="text-muted-foreground mt-1 text-xs">
        {t('invite.expires', {
          date: new Date(expiresAt).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US'),
        })}
      </p>
    </>
  );

  if (session.status === 'authenticated') {
    const alreadyMember = accept.error instanceof ApiError && accept.error.status === 409;
    return (
      <AuthLayout title={t('invite.title')}>
        <div className="grid gap-4 text-sm">
          {description}
          <p className="text-muted-foreground text-xs">
            {t('invite.signedInAs', { email: session.user?.email })}
          </p>
          {accept.isError && (
            <Alert variant="destructive">
              {alreadyMember ? t('invite.alreadyMember') : errorMessage(t, accept.error)}
            </Alert>
          )}
          {alreadyMember ? (
            <Button asChild>
              <Link to="/">{t('nav.overview')}</Link>
            </Button>
          ) : (
            <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
              {accept.isPending ? t('invite.accepting') : t('invite.accept')}
            </Button>
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('invite.registerToAccept')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link
            to={`/login?redirectTo=${encodeURIComponent(`/invite/${token}`)}`}
            className="text-primary font-medium hover:underline"
          >
            {t('invite.loginToAccept')}
          </Link>
        </>
      }
    >
      <div className="mb-4 text-sm">{description}</div>
      <RegisterForm
        invitationToken={token}
        onRegistered={() => {
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
          void navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
