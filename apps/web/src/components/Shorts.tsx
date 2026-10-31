import { REPORT_REASONS, type ArticleListResponse, type ArticleSummary, type PublicConfig, type ReportReason, type ReportResult } from '@locallens/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, errorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { formatWhen, localName, locationLabel } from '../lib/format';
import { NewsImage } from './NewsImage';
import { ShareButton } from './ShareButton';
import { TrustBadge } from './news';
import { Alert } from './ui';

export function usePublicConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<PublicConfig>('GET', '/config'), staleTime: 60 * 60_000 });
}

/** One-tap report: pick a reason, done. Enough different reports remove an unchecked post automatically. */
export function ReportButton({ article, onRemoved }: { article: ArticleSummary; onRemoved?: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const config = usePublicConfig();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (reason: ReportReason) => {
    setBusy(true);
    try {
      const res = await api<ReportResult>('POST', `/articles/${article.id}/reports`, { reason });
      setResult({ kind: 'success', text: res.removed ? t('shorts.removedNow') : t('shorts.reported') });
      if (res.removed) onRemoved?.();
    } catch (err) {
      const code = errorCode(err);
      setResult({ kind: code === 'CONFLICT' ? 'info' : 'error', text: code === 'CONFLICT' ? t('shorts.alreadyReported') : t(`errors.${code}`) });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const trigger = (
    <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100" aria-haspopup="dialog">
      <span aria-hidden="true">⚑</span> {t('shorts.report')}
    </button>
  );
  if (result && !open) return <p className={`text-sm ${result.kind === 'error' ? 'text-red-700' : 'text-slate-700'}`}>{result.text}</p>;
  if (!open) return trigger;

  // A bottom sheet over the card, so the reasons are never squeezed or cut off on a small phone.
  return (
    <>
      {trigger}
      <div className="fixed inset-0 z-40 bg-slate-900/40" onClick={() => setOpen(false)} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={t('shorts.whyReport')} className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-3xl rounded-t-2xl bg-white p-4 pb-6 shadow-2xl">
        <p className="mb-1 font-semibold">{t('shorts.whyReport')}</p>
        <p className="mb-3 line-clamp-2 text-sm text-slate-600">{article.headline}</p>
        {!user ? (
          <Link to="/login" className="font-semibold text-rose-800 underline">
            {t('shorts.signInToReport')}
          </Link>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {REPORT_REASONS.map((r) => (
              <button key={r} type="button" disabled={busy} onClick={() => void send(r)} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-medium hover:bg-red-50 disabled:opacity-60">
                {t(`reportReason.${r}`)}
              </button>
            ))}
          </div>
        )}
        {article.trustLabel === 'reporter_post' && config.data && <p className="mt-3 text-xs text-slate-600">{t('shorts.autoRemoveNote', { count: config.data.removeAfterReports })}</p>}
        <button type="button" onClick={() => setOpen(false)} className="mt-3 min-h-11 w-full rounded-xl bg-slate-100 font-medium">
          {t('mfa.cancel')}
        </button>
      </div>
    </>
  );
}

/** One story per screen: photo, headline, ~80-word summary. Swipe or scroll to the next. */
const squash = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '');
/** Some sites give no summary, only the headline again: don't print it twice. */
export const summaryAddsSomething = (a: Pick<ArticleSummary, 'headline' | 'summary'>) => {
  const sum = squash(a.summary);
  const head = squash(a.headline);
  return sum.length > 0 && sum !== head && !head.includes(sum);
};

function ShortCard({ article, onRemoved }: { article: ArticleSummary; onRemoved: () => void }) {
  const { t, i18n } = useTranslation();
  const showSummary = summaryAddsSomething(article);
  // Little text → a bigger photo instead of empty space.
  const photoClass = !showSummary || article.summary.length < 160 ? 'h-[52%]' : 'aspect-video max-h-[40%]';
  return (
    <article className="flex h-full snap-start snap-always flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={article.headline}>
      <NewsImage
        src={article.imageUrl}
        className={`${photoClass} w-full shrink-0 bg-stone-100 object-cover object-[center_30%]`}
        fallback={
          <div className="flex h-[30%] w-full shrink-0 items-center justify-center bg-gradient-to-br from-rose-600 to-rose-800 px-6 text-center text-xl font-bold text-white">
            {localName(article.category.name, i18n.language)}
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold text-rose-800">{localName(article.category.name, i18n.language)}</span>
          <span aria-hidden="true">·</span>
          <span>{locationLabel(article.location, i18n.language)}</span>
          {article.externalSource ? (
            <span className="rounded-full bg-stone-900 px-2.5 py-0.5 text-xs font-semibold text-white">{article.externalSource.name}</span>
          ) : (
            <TrustBadge label={article.trustLabel} />
          )}
        </div>
        <h2 className="text-xl leading-snug font-bold text-slate-900" lang={article.language}>
          {article.headline}
        </h2>
        {showSummary && (
          <p className="mt-2 overflow-y-auto text-base leading-relaxed text-slate-800" lang={article.language}>
            {article.summary}
          </p>
        )}
        <div className="mt-auto pt-3">
          <p className="mb-2 text-xs text-slate-500">
            <time dateTime={article.firstPublishedAt}>{formatWhen(article.firstPublishedAt, i18n.language, { today: t('shorts.today'), yesterday: t('shorts.yesterday') })}</time>
            {article.correctionCount > 0 && <span> · {t('article.correctedTimes', { count: article.correctionCount })}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <Link to={`/articles/${article.slug}`} className="inline-flex min-h-11 items-center rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white hover:bg-rose-800">
              {t('shorts.readMore')}
            </Link>
            <ShareButton article={article} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100" />
            <ReportButton article={article} onRemoved={onRemoved} />
          </div>
        </div>
      </div>
    </article>
  );
}

/** The short-news feed: vertical, one card per screen, loads more as you reach the end. */
export function ShortsFeed({ path, queryKey, emptyText }: { path: string; queryKey: unknown[]; emptyText: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const feed = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const sep = path.includes('?') ? '&' : '?';
      return api<ArticleListResponse>('GET', pageParam ? `${path}${sep}cursor=${encodeURIComponent(pageParam)}` : path);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // News keeps arriving (imports every few minutes, reporters any time): check quietly and offer to show it.
  const head = useQuery({
    queryKey: [...queryKey, 'head'],
    queryFn: () => api<ArticleListResponse>('GET', /[?&]limit=\d+/.test(path) ? path.replace(/([?&])limit=\d+/, '$1limit=1') : `${path}${path.includes('?') ? '&' : '?'}limit=1`),
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
  const newestShown = feed.data?.pages[0]?.items[0];
  const newestNow = head.data?.items[0];
  const hasNew = !!newestShown && !!newestNow && newestNow.id !== newestShown.id && newestNow.firstPublishedAt > newestShown.firstPublishedAt;
  // Each card is exactly one screen: the feed fills whatever height is left below the header and filters.
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      // Leave room for the phone tab bar when it is showing.
      const tabs = document.querySelector('[data-bottom-tabs]')?.getBoundingClientRect();
      const below = tabs && tabs.height > 0 && getComputedStyle(document.querySelector('[data-bottom-tabs]')!).display !== 'none' ? tabs.height : 0;
      setHeight(Math.max(360, window.innerHeight - Math.max(0, top) - below - 12));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });
  useEffect(() => {
    const el = end.current;
    if (!el || !feed.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !feed.isFetchingNextPage) void feed.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed]);

  if (feed.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (feed.isError) return <Alert kind="error">{t(`errors.${errorCode(feed.error)}`)}</Alert>;
  const items = feed.data.pages.flatMap((p) => p.items);
  if (!items.length) return <p className="text-slate-600">{emptyText}</p>;

  return (
    <div className="relative">
      {hasNew && (
        <button
          type="button"
          onClick={() => {
            void feed.refetch();
            box.current?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-rose-600 px-4 py-2 text-sm font-bold text-white shadow-lg hover:bg-rose-700"
        >
          ↑ {t('shorts.newStories')}
        </button>
      )}
    <div
      ref={box}
      style={height ? { height } : undefined}
      className="h-[70vh] snap-y snap-mandatory space-y-4 overflow-y-auto overscroll-contain pb-4"
      tabIndex={0}
      aria-label={t('shorts.feedLabel')}
    >
      {items.map((a) => (
        <div key={a.id} className="h-full">
          <ShortCard article={a} onRemoved={() => void qc.invalidateQueries({ queryKey })} />
        </div>
      ))}
      <div ref={end} className="h-1" />
      {feed.isFetchingNextPage && <p className="text-center text-slate-500">{t('common.loading')}</p>}
      {!feed.hasNextPage && <p className="py-6 text-center text-sm text-slate-500">{t('shorts.allCaughtUp')}</p>}
    </div>
    </div>
  );
}
