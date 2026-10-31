import type { ArticleListResponse, ArticleSummary, Category, LocationListResponse, LocationSummary, TrustLabel } from '@locallens/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, errorCode } from '../api/client';
import { formatDateTime, localName, locationLabel } from '../lib/format';
import { NewsImage } from './NewsImage';
import { Alert, Button } from './ui';

const TRUST_STYLES: Record<TrustLabel, string> = {
  editor_verified: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  citizen_reviewed: 'bg-sky-50 text-sky-900 border-sky-200',
  official_unverified: 'bg-amber-50 text-amber-900 border-amber-200',
  developing: 'bg-violet-50 text-violet-900 border-violet-200',
  reporter_post: 'bg-orange-50 text-orange-900 border-orange-200',
  external_source: 'bg-stone-100 text-stone-800 border-stone-300',
};

export function TrustBadge({ label }: { label: TrustLabel }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TRUST_STYLES[label]}`}>
      {t(`trust.${label}.short`)}
    </span>
  );
}

export function ArticleCard({ article }: { article: ArticleSummary }) {
  const { t, i18n } = useTranslation();
  return (
    <article className="flex gap-3 border-b border-slate-200 py-4 last:border-0">
      <NewsImage src={article.imageUrl} className="h-20 w-24 shrink-0 rounded-lg bg-stone-100 object-cover sm:h-24 sm:w-32" />
      <div className="min-w-0 flex-1">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span className="font-semibold text-rose-800">{localName(article.category.name, i18n.language)}</span>
        <span aria-hidden="true">·</span>
        <span>{locationLabel(article.location, i18n.language)}</span>
      </div>
      <h3 className="text-lg leading-snug font-bold" lang={article.language}>
        <Link to={`/articles/${article.slug}`} className="hover:underline">
          {article.headline}
        </Link>
      </h3>
      <p className="mt-1 text-slate-700" lang={article.language}>
        {article.summary}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <TrustBadge label={article.trustLabel} />
        <time dateTime={article.firstPublishedAt}>{formatDateTime(article.firstPublishedAt, i18n.language)}</time>
        {article.correctionCount > 0 && <span>· {t('article.correctedTimes', { count: article.correctionCount })}</span>}
      </div>
      </div>
    </article>
  );
}

/** Infinite list of articles from any endpoint returning { items, nextCursor }. */
export function ArticleFeed({ queryKey, path, emptyText }: { queryKey: unknown[]; path: string; emptyText: string }) {
  const { t } = useTranslation();
  const feed = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const sep = path.includes('?') ? '&' : '?';
      return api<ArticleListResponse>('GET', pageParam ? `${path}${sep}cursor=${encodeURIComponent(pageParam)}` : path);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  if (feed.isPending) return <p className="py-6 text-slate-500">{t('common.loading')}</p>;
  if (feed.isError) return <Alert kind="error">{t(`errors.${errorCode(feed.error)}`)}</Alert>;
  if (!items.length) return <p className="py-6 text-slate-600">{emptyText}</p>;
  return (
    <div>
      {items.map((a) => (
        <ArticleCard key={a.id} article={a} />
      ))}
      {feed.hasNextPage && (
        <Button variant="secondary" className="mt-3 w-full" busy={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
          {t('feed.loadMore')}
        </Button>
      )}
    </div>
  );
}

export function CategoryChips({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const chip = (active: boolean) =>
    `min-h-9 shrink-0 rounded-full border px-3 text-sm font-medium ${active ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white text-slate-800'}`;
  return (
    <div role="group" aria-label={t('feed.categories')} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      <button type="button" aria-pressed={selected === null} className={chip(selected === null)} onClick={() => onSelect(null)}>
        {t('feed.allTopics')}
      </button>
      {categories.map((c) => (
        <button key={c.id} type="button" aria-pressed={selected === c.id} className={chip(selected === c.id)} onClick={() => onSelect(c.id)}>
          {localName(c.name, i18n.language)}
        </button>
      ))}
    </div>
  );
}

/** Type-ahead search over locations (English, Telugu and alternative spellings). */
export function LocationPicker({
  label,
  onPick,
  levels,
}: {
  label: string;
  onPick: (loc: LocationSummary) => void;
  levels?: LocationSummary['level'][];
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const results = useQuery({
    queryKey: ['location-search', debounced],
    queryFn: () => api<LocationListResponse>('GET', `/locations/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 1,
  });
  const items = (results.data?.items ?? []).filter((l) => !levels || levels.includes(l.level));
  return (
    <div className="relative mb-4">
      <label htmlFor={id} className="mb-1 block font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        type="search"
        autoComplete="off"
        value={q}
        placeholder={t('places.searchPlaceholder')}
        onChange={(e) => setQ(e.target.value)}
        className="block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base focus:outline-2 focus:outline-rose-700"
      />
      {debounced && results.isSuccess && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {items.length === 0 && <li className="px-3 py-2 text-slate-600">{t('places.noMatches')}</li>}
          {items.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-rose-50 focus:bg-rose-50"
                onClick={() => {
                  onPick(l);
                  setQ('');
                  setDebounced('');
                }}
              >
                <span className="font-medium">{localName(l.name, i18n.language)}</span>{' '}
                <span className="text-sm text-slate-600">
                  {t(`levels.${l.level}`)} · {locationLabel(l, i18n.language)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
