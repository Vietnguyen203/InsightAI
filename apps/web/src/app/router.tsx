import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { RedirectIfAuthenticated, RequireAuth, RequireSession } from '@/features/auth/guards';
import { InvitePage } from '@/features/auth/invite-page';
import { LoginPage } from '@/features/auth/login-page';
import { RegisterPage } from '@/features/auth/register-page';
import { DatasetDetailPage } from '@/features/datasets/dataset-detail-page';
import { DatasetListPage } from '@/features/datasets/dataset-list-page';
import { NewOrganizationPage, OnboardingPage } from '@/features/organizations/onboarding-page';
import { OverviewPage } from '@/features/overview/overview-page';
import { AuditPage } from '@/features/settings/audit-page';
import { MembersPage } from '@/features/settings/members-page';
import { SemanticListPage } from '@/features/semantic/semantic-list-page';
import { SemanticModelPage } from '@/features/semantic/semantic-model-page';
import { OrganizationSettingsPage } from '@/features/settings/organization-settings-page';
import { SystemStatusPage } from '@/features/system/system-status-page';
import { NotFoundPage } from './not-found-page';
import { Root } from './root';

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      {
        path: 'login',
        element: (
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        ),
      },
      {
        path: 'register',
        element: (
          <RedirectIfAuthenticated>
            <RegisterPage />
          </RedirectIfAuthenticated>
        ),
      },
      { path: 'invite/:token', element: <InvitePage /> },
      {
        path: 'onboarding',
        element: (
          <RequireSession>
            <OnboardingPage />
          </RequireSession>
        ),
      },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'datasets', element: <DatasetListPage /> },
          { path: 'datasets/:datasetId', element: <DatasetDetailPage /> },
          { path: 'semantic', element: <SemanticListPage /> },
          { path: 'semantic/:modelId', element: <SemanticModelPage /> },
          { path: 'organizations/new', element: <NewOrganizationPage /> },
          { path: 'settings/organization', element: <OrganizationSettingsPage /> },
          { path: 'settings/members', element: <MembersPage /> },
          { path: 'settings/audit', element: <AuditPage /> },
          { path: 'system', element: <SystemStatusPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
