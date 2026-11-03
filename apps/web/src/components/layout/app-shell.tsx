import {
  Activity,
  BarChart3,
  Database,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Moon,
  ShieldCheck,
  Shapes,
  Sun,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { Button } from '@/components/ui/button';
import { type Language, persistLanguage, SUPPORTED_LANGUAGES } from '@/i18n';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** Feature not built yet: shown so the product structure is visible, but not navigable. */
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.overview', icon: LayoutDashboard },
  { to: '/datasets', labelKey: 'nav.datasets', icon: Database, disabled: true },
  { to: '/quality', labelKey: 'nav.quality', icon: ShieldCheck, disabled: true },
  { to: '/semantic', labelKey: 'nav.semantic', icon: Shapes, disabled: true },
  { to: '/ask', labelKey: 'nav.ask', icon: MessageSquareText, disabled: true },
  { to: '/dashboards', labelKey: 'nav.dashboards', icon: BarChart3, disabled: true },
  { to: '/system', labelKey: 'nav.system', icon: Activity },
];

function NavEntry({ item, compact }: { item: NavItem; compact?: boolean }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const base = 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap';

  if (item.disabled) {
    return (
      <span
        aria-disabled="true"
        title={t('nav.comingSoon')}
        className={cn(base, 'text-muted-foreground/60 cursor-not-allowed')}
      >
        <Icon className="size-4" />
        {t(item.labelKey)}
        {!compact && <span className="ml-auto text-[10px] uppercase">{t('nav.comingSoon')}</span>}
      </span>
    );
  }

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

export function AppShell() {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  const changeLanguage = (language: Language) => {
    persistLanguage(language);
    void i18n.changeLanguage(language);
  };

  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <img src="/favicon.svg" alt="" className="size-6" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">{t('app.name')}</div>
            <div className="text-muted-foreground text-xs">{t('app.tagline')}</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-3" aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b px-4">
          <span className="text-sm font-semibold md:hidden">{t('app.name')}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="language-select">
              {t('language.label')}
            </label>
            <select
              id="language-select"
              value={i18n.language}
              onChange={(event) => changeLanguage(event.target.value as Language)}
              className="bg-background h-9 rounded-md border px-2 text-sm"
            >
              {SUPPORTED_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {t(`language.${language}`)}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={t('theme.toggle')}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>

        <nav
          className="flex gap-1 overflow-x-auto border-b px-2 py-1 md:hidden"
          aria-label="Main mobile"
        >
          {NAV_ITEMS.filter((item) => !item.disabled).map((item) => (
            <NavEntry key={item.to} item={item} compact />
          ))}
        </nav>

        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
