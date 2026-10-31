import { LANGUAGES, type Language } from '@locallens/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useUnreadCount } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { setLanguage } from '../i18n';
import { Icon } from './icons';
import { useAssistantEnabled } from './AssistantPanel';
import { InstallAppButton } from './InstallApp';

export function Logo() {
  const { t } = useTranslation();
  return (
    <Link to="/" className="flex items-center gap-2" aria-label={t('app.name')}>
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-rose-600 text-lg font-black text-white shadow-sm">
        L
      </span>
      <span className="hidden text-xl font-extrabold tracking-tight text-stone-900 min-[360px]:inline">
        Local<span className="text-rose-600">Lens</span>
      </span>
    </Link>
  );
}

function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <div role="group" aria-label={t('nav.language')} className="flex overflow-hidden rounded-full border border-stone-300 bg-white text-xs">
      {LANGUAGES.map((lang: Language) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          aria-pressed={i18n.language === lang}
          onClick={() => setLanguage(lang)}
          className={`min-h-9 px-3 font-semibold ${i18n.language === lang ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}
        >
          {lang === 'te' ? 'తె' : 'EN'}
        </button>
      ))}
    </div>
  );
}

function SubNav({ label, links }: { label: string; links: [string, string][] }) {
  return (
    <nav aria-label={label} className="border-b border-stone-200 bg-white">
      <div className="no-scrollbar mx-auto flex max-w-3xl gap-1 overflow-x-auto px-3 py-2">
        {links.map(([to, text]) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) => `shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-rose-600 text-white' : 'text-stone-700 hover:bg-stone-100'}`}
          >
            {text}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/** The profile menu: everything beyond reading and posting lives here, so the main screen stays simple. */
function ProfileMenu() {
  const { t } = useTranslation();
  const { user, hasRole, signOut } = useAuth();
  const assistant = useAssistantEnabled();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!user) return null;

  const item = (to: string, label: string) => (
    <Link to={to} role="menuitem" className="block rounded-lg px-3 py-2 text-sm text-stone-800 hover:bg-stone-100">
      {label}
    </Link>
  );
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('nav.menu')}
        onClick={() => setOpen(!open)}
        className="grid size-10 place-items-center rounded-full bg-stone-900 text-sm font-bold text-white"
      >
        {user.displayName.trim().charAt(0).toUpperCase() || '?'}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-60 rounded-2xl border border-stone-200 bg-white p-2 shadow-xl">
          <p className="px-3 pt-1 pb-2 text-sm">
            <span className="block font-semibold text-stone-900">{user.displayName}</span>
            <span className="block truncate text-xs text-stone-500">{user.email}</span>
          </p>
          <div className="border-t border-stone-100 pt-1">
            <InstallAppButton className="block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-rose-700 hover:bg-rose-50" onDone={() => setOpen(false)} />
            {item('/account', t('nav.account'))}
            {hasRole('reporter') ? item('/my-posts', t('nav.myPosts')) : item('/account#reporter', t('account.becomeReporter'))}
            {item('/saved', t('nav.saved'))}
            {item('/notifications', t('nav.alerts'))}
            {item('/places', t('nav.places'))}
            {item('/deadlines', t('nav.deadlines'))}
            {assistant && item('/ask', t('nav.askAi'))}
            {hasRole('publisher') && item('/publisher', t('nav.announce'))}
            {hasRole('editor', 'senior_editor', 'admin') && item('/editor/queue', t('nav.editor'))}
            {hasRole('admin') && item('/admin/users', t('nav.adminArea'))}
          </div>
          <div className="mt-1 border-t border-stone-100 pt-1">
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-rose-700 hover:bg-rose-50"
              onClick={async () => {
                setOpen(false);
                await signOut();
                navigate('/', { replace: true });
              }}
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabLink({ to, label, icon, badge, end }: { to: string; label: string; icon: ReactNode; badge?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${isActive ? 'text-rose-600' : 'text-stone-500'}`}
    >
      {icon}
      {label}
      {!!badge && (
        <span aria-hidden="true" className="absolute top-1 right-[calc(50%-1.25rem)] min-w-4 rounded-full bg-rose-600 px-1 text-[10px] leading-4 text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  );
}

/** Phone tab bar for signed-in people: News · (Post) · My posts or Saved · Alerts. */
function BottomTabs({ unread }: { unread: number }) {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  const reporter = hasRole('reporter', 'editor', 'senior_editor', 'admin');
  return (
    <nav data-bottom-tabs aria-label={t('nav.tabs')} className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
      <div className="mx-auto flex max-w-3xl items-end">
        <TabLink to="/news" label={t('nav.news')} icon={<Icon name="news" />} />
        {reporter && (
          <NavLink to="/post" aria-label={t('nav.postNews')} className={({ isActive }) => `flex flex-1 flex-col items-center py-1 ${isActive ? '[&>span:last-child]:text-rose-600' : ''}`}>
            <span aria-hidden="true" className="-mt-5 grid size-12 place-items-center rounded-full bg-rose-600 text-2xl font-bold text-white shadow-lg ring-4 ring-white">
              +
            </span>
            <span className="text-[11px] font-semibold text-stone-600">{t('nav.post')}</span>
          </NavLink>
        )}
        {hasRole('reporter') ? <TabLink to="/my-posts" label={t('nav.myPosts')} icon={<Icon name="posts" />} /> : <TabLink to="/saved" label={t('nav.saved')} icon={<Icon name="saved" />} />}
        <TabLink to="/notifications" label={t('nav.alerts')} icon={<Icon name="bell" />} badge={unread} />
      </div>
    </nav>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const { user, hasRole } = useAuth();
  const unread = useUnreadCount().data?.unreadCount ?? 0;
  const { pathname } = useLocation();
  const desktopLink = ({ isActive }: { isActive: boolean }) => `rounded-full px-3 py-1.5 text-sm font-semibold ${isActive ? 'bg-rose-50 text-rose-700' : 'text-stone-700 hover:bg-stone-100'}`;

  return (
    <div className={`flex min-h-dvh flex-col ${user ? 'pb-16 sm:pb-0' : ''}`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-white focus:p-2">
        {t('app.skipToContent')}
      </a>
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
          <Logo />
          {user && (
            <nav aria-label="Main" className="ml-4 hidden items-center gap-1 sm:flex">
              <NavLink to="/news" className={desktopLink}>
                {t('nav.news')}
              </NavLink>
              {hasRole('reporter') && (
                <NavLink to="/my-posts" className={desktopLink}>
                  {t('nav.myPosts')}
                </NavLink>
              )}
              <NavLink to="/notifications" className={desktopLink}>
                {t('nav.alerts')}
                {unread > 0 && <span className="ml-1 rounded-full bg-rose-600 px-1.5 text-xs text-white">{unread > 99 ? '99+' : unread}</span>}
              </NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
            {user ? (
              <>
                {hasRole('reporter', 'editor', 'senior_editor', 'admin') && (
                  <Link to="/post" className="hidden min-h-10 items-center rounded-full bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-700 sm:inline-flex">
                    + {t('nav.postNews')}
                  </Link>
                )}
                <ProfileMenu />
              </>
            ) : (
              <>
                <Link to="/login" className="hidden min-h-10 items-center px-2 text-sm font-semibold text-stone-800 hover:text-rose-700 min-[400px]:inline-flex">
                  {t('nav.signIn')}
                </Link>
                <Link to="/register" className="inline-flex min-h-10 items-center rounded-full bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-700">
                  {t('nav.signUp')}
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      {user && pathname.startsWith('/editor') && hasRole('editor', 'senior_editor', 'admin') && (
        <SubNav
          label={t('nav.editor')}
          links={[
            ['/editor/queue', t('nav.reviewQueue')],
            ['/editor', t('nav.articles')],
            ['/editor/new', t('editor.new')],
            ['/editor/reports', t('nav.readerReports')],
            ...(hasRole('senior_editor', 'admin') ? ([['/editor/appeals', t('nav.appeals')]] as [string, string][]) : []),
          ]}
        />
      )}
      {user && pathname.startsWith('/admin') && hasRole('admin') && (
        <SubNav
          label={t('nav.adminArea')}
          links={[
            ['/admin/users', t('nav.admin')],
            ['/admin/locations', t('nav.places')],
            ['/admin/publishers', t('nav.publishers')],
            ['/admin/ops', t('nav.ops')],
            ['/admin/audit', t('nav.audit')],
          ]}
        />
      )}
      {user?.mfa.requiredForRoles && !user.mfa.enabled && pathname !== '/account' && (
        <div className="border-b border-amber-200 bg-amber-50">
          <p className="mx-auto max-w-3xl px-4 py-2 text-sm text-amber-950">
            {t('mfa.banner')}{' '}
            <Link to="/account#two-step" className="font-semibold underline">
              {t('mfa.bannerLink')}
            </Link>
          </p>
        </div>
      )}
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-4">
        <Outlet />
      </main>
      {!user && <footer className="border-t border-stone-200 bg-white py-5 text-center text-sm text-stone-500">{t('app.tagline')}</footer>}
      {user && <BottomTabs unread={unread} />}
    </div>
  );
}
