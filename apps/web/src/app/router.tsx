import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { OverviewPage } from '@/features/overview/overview-page';
import { SystemStatusPage } from '@/features/system/system-status-page';
import { NotFoundPage } from './not-found-page';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'system', element: <SystemStatusPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
