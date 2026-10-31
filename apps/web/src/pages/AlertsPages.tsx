import type { DeadlinesResponse, LocationResponse, NotificationsResponse } from '@locallens/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { api, errorCode } from '../api/client';
import { LocationPicker } from '../components/news';
import { Alert, Button, Card, PageTitle, StatusPill } from '../components/ui';
import { daysUntil, formatDateTime, formatDay, localName, locationLabel } from '../lib/format';

/** "3 days left", "Last day today" — the part of a deadline people act on. */
export function DaysLeft({ day }: { day: string }) {
  const { t } = useTranslation();
  const n = daysUntil(day);
  if (n < 0) return <StatusPill>{t('deadlines.closed')}</StatusPill>;
  return <StatusPill tone={n <= 3 ? 'red' : 'amber'}>{n === 0 ? t('deadlines.today') : t('deadlines.daysLeft', { count: n })}</StatusPill>;
}

export function NotificationsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ['notifications', 'list'],
    queryFn: ({ pageParam }) => api<NotificationsResponse>('GET', `/me/notifications${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api('POST', '/me/notifications/read', ids ? { ids } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  if (list.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (list.isError) return <Alert kind="error">{t(`errors.${errorCode(list.error)}`)}</Alert>;
  const items = list.data.pages.flatMap((p) => p.items);
  const unread = list.data.pages[0]?.unreadCount ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>{t('alerts.title')}</PageTitle>
        {unread > 0 && (
          <Button variant="secondary" busy={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
            {t('alerts.markAllRead')}
          </Button>
        )}
      </div>
      <Card>
        {items.length === 0 ? (
          <p className="text-slate-600">{t('alerts.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {items.map((n) => (
              <li key={n.id} className={`py-3 ${n.readAt ? '' : 'font-semibold'}`}>
                <p className="text-sm text-slate-600">
                  {!n.readAt && <span className="mr-1 inline-block size-2 rounded-full bg-rose-700" aria-label={t('alerts.unread')} />}
                  {t(`alerts.kind_${n.kind}`)} · <time dateTime={n.createdAt}>{formatDateTime(n.createdAt, i18n.language)}</time>
                </p>
                <Link
                  to={`/articles/${n.article.slug}`}
                  className="text-rose-800 underline"
                  onClick={() => {
                    if (!n.readAt) markRead.mutate([n.id]);
                  }}
                >
                  {n.article.headline}
                </Link>
                {n.kind === 'deadline_soon' && n.article.deadline && (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-normal">
                    {t('article.deadline')} {formatDay(n.article.deadline, i18n.language)} <DaysLeft day={n.article.deadline} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <Button variant="secondary" className="mt-3" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('feed.loadMore')}
          </Button>
        )}
      </Card>
      <p className="text-sm text-slate-600">{t('alerts.howItWorks')}</p>
    </div>
  );
}

/** Upcoming last dates (applications, fees, exams), soonest first, for one place (?place=) or everywhere. */
export function DeadlinesList({ locationId, limit = 20 }: { locationId?: string; limit?: number }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({
    queryKey: ['deadlines', locationId ?? 'all', limit],
    queryFn: () => api<DeadlinesResponse>('GET', `/articles/deadlines?limit=${limit}${locationId ? `&locationId=${locationId}` : ''}`),
  });
  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) return <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>;
  if (!q.data.items.length) return <p className="text-slate-600">{t('deadlines.none')}</p>;
  return (
    <ul className="divide-y divide-slate-200">
      {q.data.items.map((a) => (
        <li key={a.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{a.deadline && formatDay(a.deadline, i18n.language)}</strong>
            {a.deadline && <DaysLeft day={a.deadline} />}
            <span className="text-slate-600">{locationLabel(a.location, i18n.language)}</span>
          </div>
          <Link to={`/articles/${a.slug}`} lang={a.language} className="font-semibold text-rose-800 underline">
            {a.headline}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DeadlinesPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const placeId = params.get('place') ?? undefined;
  const place = useQuery({ queryKey: ['location', placeId], queryFn: () => api<LocationResponse>('GET', `/locations/${placeId}`), enabled: !!placeId });
  return (
    <div className="space-y-4">
      <PageTitle>{t('deadlines.title')}</PageTitle>
      <p className="text-slate-700">{t('deadlines.intro')}</p>
      {placeId && place.data ? (
        <p className="flex flex-wrap items-center gap-2">
          {t('assistant.limitedTo', { place: localName(place.data.location.name, i18n.language) })}
          <button type="button" className="text-sm underline" onClick={() => setParams({})}>
            {t('assistant.allPlaces')}
          </button>
        </p>
      ) : (
        <LocationPicker label={t('assistant.pickPlace')} onPick={(loc) => setParams({ place: loc.id })} />
      )}
      <Card>
        <DeadlinesList {...(placeId ? { locationId: placeId } : {})} limit={50} />
      </Card>
    </div>
  );
}
