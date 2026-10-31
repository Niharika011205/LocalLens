import type { ArticleListResponse } from '@locallens/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useCategories } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/icons';
import { InstallAppButton } from '../components/InstallApp';
import { NewsImage } from '../components/NewsImage';
import { CategoryChips } from '../components/news';
import { ShortsFeed, usePublicConfig } from '../components/Shorts';
import { Card, PageTitle } from '../components/ui';
import { formatDateTime, localName, locationLabel } from '../lib/format';

/** "/" — the landing page, for everyone. The news itself is at /news (the News tab). */
export function HomePage() {
  return <LandingPage />;
}

/** The news: one story per screen, filtered by topic. Open to everyone at /news too. */
export function NewsPage() {
  const { t } = useTranslation();
  const categories = useCategories();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {categories.data && <CategoryChips categories={categories.data.items} selected={categoryId} onSelect={setCategoryId} />}
      <ShortsFeed queryKey={['feed', 'latest', categoryId]} path={`/articles?limit=10${categoryId ? `&categoryId=${categoryId}` : ''}`} emptyText={t('feed.emptyLatest')} />
    </div>
  );
}

function Feature({ icon, title, body }: { icon: Parameters<typeof Icon>[0]['name']; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5">
      <span className="mb-3 grid size-11 place-items-center rounded-xl bg-rose-50 text-rose-600">
        <Icon name={icon} />
      </span>
      <h3 className="font-bold text-stone-900">{title}</h3>
      <p className="mt-1 text-sm text-stone-600">{body}</p>
    </div>
  );
}

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const config = usePublicConfig();
  const { user, hasRole } = useAuth();
  const latest = useQuery({ queryKey: ['feed', 'landing'], queryFn: () => api<ArticleListResponse>('GET', '/articles?limit=6') });

  return (
    <div className="space-y-10 pb-6">
      <section className="relative overflow-hidden rounded-3xl bg-stone-900 px-6 py-10 text-white sm:px-10 sm:py-14">
        <div aria-hidden="true" className="absolute -top-16 -right-16 size-56 rounded-full bg-rose-600/40 blur-2xl" />
        <div aria-hidden="true" className="absolute -bottom-20 -left-10 size-48 rounded-full bg-amber-400/20 blur-2xl" />
        <div className="relative">
          <p className="mb-3 inline-block rounded-full bg-white/10 px-3 py-1 text-xs font-semibold tracking-wide text-rose-100">{t('landing.badge')}</p>
          <h1 className="max-w-xl text-3xl leading-tight font-extrabold sm:text-5xl">{t('landing.title')}</h1>
          <p className="mt-4 max-w-lg text-base text-stone-300 sm:text-lg">{t('landing.subtitle')}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            {user ? (
              <>
                <Link to="/news" className="inline-flex min-h-12 items-center rounded-full bg-rose-600 px-6 font-bold text-white hover:bg-rose-500">
                  {t('landing.read')}
                </Link>
                {hasRole('reporter', 'editor', 'senior_editor', 'admin') && (
                  <Link to="/post" className="inline-flex min-h-12 items-center rounded-full bg-white px-6 font-bold text-stone-900 hover:bg-stone-100">
                    + {t('nav.postNews')}
                  </Link>
                )}
              </>
            ) : (
              <>
                <Link to="/register" className="inline-flex min-h-12 items-center rounded-full bg-rose-600 px-6 font-bold text-white hover:bg-rose-500">
                  {t('landing.cta')}
                </Link>
                <Link to="/news" className="inline-flex min-h-12 items-center rounded-full bg-white px-6 font-bold text-stone-900 hover:bg-stone-100">
                  {t('landing.read')}
                </Link>
              </>
            )}
          </div>
          <InstallAppButton className="mt-3 inline-flex min-h-11 items-center rounded-full border border-white/40 px-5 text-sm font-bold text-white hover:bg-white/10" />
          {user ? (
            <p className="mt-4 text-sm text-stone-300">{t('landing.welcomeBack', { name: user.displayName })}</p>
          ) : (
            <p className="mt-4 text-sm text-stone-400">
              {t('landing.haveAccount')}{' '}
              <Link to="/login" className="font-semibold text-white underline">
                {t('nav.signIn')}
              </Link>
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="how" className="space-y-4">
        <h2 id="how" className="text-xl font-extrabold text-stone-900">
          {t('landing.howTitle')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Feature icon="news" title={t('landing.f1Title')} body={t('landing.f1Body')} />
          <Feature icon="camera" title={t('landing.f2Title')} body={t('landing.f2Body')} />
          <Feature icon="flag" title={t('landing.f3Title')} body={t('landing.f3Body', { count: config.data?.removeAfterReports ?? 10 })} />
        </div>
      </section>

      <section aria-labelledby="latest" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="latest" className="text-xl font-extrabold text-stone-900">
            {t('landing.latest')}
          </h2>
          <Link to="/news" className="text-sm font-semibold text-rose-700 hover:underline">
            {t('landing.seeAll')} →
          </Link>
        </div>
        {latest.data && !latest.data.items.length && <p className="text-stone-600">{t('feed.emptyLatest')}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          {latest.data?.items.map((a) => (
            <Link key={a.id} to={`/articles/${a.slug}`} className="group overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <NewsImage
                src={a.imageUrl}
                className="aspect-[16/10] w-full object-cover"
                fallback={<div className="grid aspect-[16/10] w-full place-items-center bg-gradient-to-br from-rose-500 to-rose-700 text-sm font-bold text-white">{localName(a.category.name, i18n.language)}</div>}
              />
              <div className="p-3">
                <p className="text-xs text-stone-500">
                  {a.externalSource ? <span className="font-semibold text-stone-700">{a.externalSource.name}</span> : locationLabel(a.location, i18n.language)} · {formatDateTime(a.firstPublishedAt, i18n.language)}
                </p>
                <h3 className="mt-1 line-clamp-3 font-bold leading-snug text-stone-900 group-hover:text-rose-700" lang={a.language}>
                  {a.headline}
                </h3>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {!hasRole('reporter') && (
      <section className="rounded-3xl bg-rose-600 px-6 py-8 text-center text-white">
        <h2 className="text-2xl font-extrabold">{t('landing.reporterTitle')}</h2>
        <p className="mx-auto mt-2 max-w-md text-rose-100">{t('landing.reporterBody')}</p>
        <Link to="/register?as=reporter" className="mt-5 inline-flex min-h-12 items-center rounded-full bg-white px-6 font-bold text-rose-700 hover:bg-rose-50">
          {t('landing.reporterCta')}
        </Link>
      </section>
      )}
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <PageTitle>{t('notFound.title')}</PageTitle>
      <p className="mb-4 text-stone-700">{t('notFound.body')}</p>
      <Link to="/" className="font-medium text-rose-700 underline">
        {t('common.backHome')}
      </Link>
    </Card>
  );
}
