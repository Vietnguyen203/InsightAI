import { Permission } from '@insightai/contracts';
import {
  Activity,
  BarChart3,
  Building2,
  Database,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  MessageSquareText,
  Microscope,
  Moon,
  ScrollText,
  Shapes,
  Sun,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { useSession, useSessionActions } from '@/features/auth/use-session';
import {
  useActiveOrganization,
  useCurrentOrganization,
} from '@/features/organizations/use-organization';
import { type Language, persistLanguage, SUPPORTED_LANGUAGES } from '@/i18n';
import { setActiveOrganizationId } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** Hidden unless the user holds this permission in the active organization. */
  permission?: Permission;
}

const MAIN_NAV: NavItem[] = [
  { to: '/', labelKey: 'nav.overview', icon: LayoutDashboard },
  { to: '/datasets', labelKey: 'nav.datasets', icon: Database },
  { to: '/semantic', labelKey: 'nav.semantic', icon: Shapes },
  { to: '/ask', labelKey: 'nav.ask', icon: MessageSquareText },
  { to: '/dashboards', labelKey: 'nav.dashboards', icon: BarChart3 },
  {
    to: '/investigations',
    labelKey: 'nav.investigations',
    icon: Microscope,
    permission: Permission.SEMANTIC_QUERY,
  },
];

const SETTINGS_NAV: NavItem[] = [
  { to: '/settings/organization', labelKey: 'nav.organization', icon: Building2 },
  { to: '/settings/members', labelKey: 'nav.members', icon: Users },
  {
    to: '/settings/audit',
    labelKey: 'nav.audit',
    icon: ScrollText,
    permission: Permission.AUDIT_READ,
  },
  { to: '/system', labelKey: 'nav.system', icon: Activity },
];

function NavEntry({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const base = 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap';

  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          base,
          isActive
            ? 'bg-sidebar-accent text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
        )
      }
    >
      <Icon className="size-4" />
      {t(item.labelKey)}
    </NavLink>
  );
}

const NEW_ORGANIZATION = '__new__';

function OrganizationSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { organizationId, memberships } = useActiveOrganization();
  return (
    <NativeSelect
      aria-label={t('orgSwitcher.label')}
      className="h-9 w-auto max-w-56"
      value={organizationId ?? ''}
      onChange={(event) => {
        if (event.target.value === NEW_ORGANIZATION) {
          void navigate('/organizations/new');
          return;
        }
        setActiveOrganizationId(event.target.value);
        void navigate('/');
      }}
    >
      {memberships.map((m) => (
        <option key={m.organizationId} value={m.organizationId}>
          {m.organizationName}
        </option>
      ))}
      <option value={NEW_ORGANIZATION}>{t('orgSwitcher.create')}</option>
    </NativeSelect>
  );
}

export function AppShell() {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const session = useSession();
  const { signOut } = useSessionActions();
  const navigate = useNavigate();
  const { data: current } = useCurrentOrganization();

  const visible = (item: NavItem) =>
    !item.permission || (current?.permissions.includes(item.permission) ?? false);
  const mainNav = MAIN_NAV.filter(visible);
  const settingsNav = SETTINGS_NAV.filter(visible);

  const changeLanguage = (language: Language) => {
    persistLanguage(language);
    void i18n.changeLanguage(language);
  };

  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:flex print:hidden">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <img src="/favicon.svg" alt="" className="size-6" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">{t('app.name')}</div>
            <div className="text-muted-foreground text-xs">{t('app.tagline')}</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main">
          {mainNav.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
          <div className="text-muted-foreground mt-4 px-3 pb-1 text-xs font-medium uppercase">
            {t('nav.settings')}
          </div>
          {settingsNav.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>
        <div className="border-t p-3 text-xs">
          <div className="truncate font-medium">{session.user?.fullName}</div>
          <div className="text-muted-foreground truncate">{session.user?.email}</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 print:hidden">
          <OrganizationSwitcher />
          <div className="ml-auto flex items-center gap-1">
            <label className="sr-only" htmlFor="language-select">
              {t('language.label')}
            </label>
            <NativeSelect
              id="language-select"
              className="hidden h-9 w-auto sm:block"
              value={i18n.language}
              onChange={(event) => changeLanguage(event.target.value as Language)}
            >
              {SUPPORTED_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {t(`language.${language}`)}
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={t('theme.toggle')}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('auth.logout')}
              title={t('auth.logout')}
              onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}
            >
              <LogOut />
            </Button>
          </div>
        </header>

        <nav
          className="flex gap-1 overflow-x-auto border-b px-2 py-1 md:hidden print:hidden"
          aria-label="Main mobile"
        >
          {[...mainNav, ...settingsNav].map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        <main className="flex-1 p-4 md:p-6 print:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
