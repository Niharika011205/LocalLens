import type { LocationListResponse, LocationResponse } from '@locallens/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, errorCode } from '../api/client';
import { useFollows, useToggleFollow } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { ArticleFeed, LocationPicker } from '../components/news';
import { PlaceMap } from '../components/PlaceMap';
import { DeadlinesList } from './AlertsPages';
import { Alert, Button, Card, PageTitle } from '../components/ui';
import { localName } from '../lib/format';

export function PlacePage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const follows = useFollows();
  const toggle = useToggleFollow();
  const place = useQuery({ queryKey: ['location', id], queryFn: () => api<LocationResponse>('GET', `/locations/${id}`) });
  const children = useQuery({
    queryKey: ['locations', 'children', id],
    queryFn: () => api<LocationListResponse>('GET', `/locations?parentId=${id}`),
  });

  if (place.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (place.isError) return <Alert kind="error">{t(`errors.${errorCode(place.error)}`)}</Alert>;

  const loc = place.data.location;
  const following = !!follows.data?.locations.some((l) => l.id === loc.id);
  return (
    <div className="space-y-4">
      <nav aria-label={t('places.breadcrumb')} className="text-sm text-slate-600">
        {loc.ancestors.map((a) => (
          <span key={a.id}>
            <Link to={`/places/${a.id}`} className="underline">
              {localName(a.name, i18n.language)}
            </Link>{' '}
            ›{' '}
          </span>
        ))}
        <span>{t(`levels.${loc.level}`)}</span>
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>{localName(loc.name, i18n.language)}</PageTitle>
        {user && (
          <Button variant={following ? 'secondary' : 'primary'} busy={toggle.isPending} aria-pressed={following} onClick={() => toggle.mutate({ type: 'location', id: loc.id, follow: !following })}>
            {following ? t('places.following') : t('places.follow')}
          </Button>
        )}
      </div>

      {!!children.data?.items.length && (
        <Card>
          <h2 className="mb-2 font-semibold">{t('places.inside', { place: localName(loc.name, i18n.language) })}</h2>
          <ul className="flex flex-wrap gap-2">
            {children.data.items.map((c) => (
              <li key={c.id}>
                <Link to={`/places/${c.id}`} className="inline-block rounded-full border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-rose-50">
                  {localName(c.name, i18n.language)}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PlaceMap locationId={loc.id} name={localName(loc.name, i18n.language)} />

      <Card>
        <h2 className="mb-1 font-semibold">{t('deadlines.upcoming')}</h2>
        <DeadlinesList locationId={loc.id} limit={5} />
        <Link to={`/deadlines?place=${loc.id}`} className="mt-2 inline-block text-sm text-rose-800 underline">
          {t('deadlines.all')}
        </Link>
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold">{t('places.news')}</h2>
        <p className="mb-2 text-sm text-slate-600">{t('places.newsHint')}</p>
        <ArticleFeed queryKey={['feed', 'place', loc.id]} path={`/articles?locationId=${loc.id}&limit=20`} emptyText={t('places.noNews')} />
      </Card>
      <p>
        <Link to={`/ask?place=${loc.id}`} className="font-semibold text-rose-800 underline">
          {t('assistant.askAboutPlace', { place: localName(loc.name, i18n.language) })}
        </Link>
      </p>
    </div>
  );
}

export function SavedPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <PageTitle>{t('saved.title')}</PageTitle>
      <Card>
        <ArticleFeed queryKey={['saved', 'list']} path="/me/saved" emptyText={t('saved.empty')} />
      </Card>
    </div>
  );
}

export function SearchPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  return (
    <div className="space-y-4">
      <PageTitle>{t('search.resultsFor', { q })}</PageTitle>
      <Card>
        {q.length >= 2 ? (
          <ArticleFeed queryKey={['search', q]} path={`/articles/search?q=${encodeURIComponent(q)}`} emptyText={t('search.none')} />
        ) : (
          <p className="text-slate-600">{t('search.tooShort')}</p>
        )}
      </Card>
    </div>
  );
}

/** All places, starting from the states. Each place page lists the places inside it, down to villages. */
export function PlacesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const states = useQuery({ queryKey: ['locations', 'children', 'root'], queryFn: () => api<LocationListResponse>('GET', '/locations') });
  return (
    <div className="space-y-4">
      <PageTitle>{t('places.browseTitle')}</PageTitle>
      <p className="text-stone-700">{t('places.browseIntro')}</p>
      <Card>
        <LocationPicker label={t('places.findPlace')} onPick={(l) => navigate(`/places/${l.id}`)} />
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">{t('places.states')}</h2>
        {states.isPending && <p className="text-stone-500">{t('common.loading')}</p>}
        {states.data && !states.data.items.length && <p className="text-stone-600">{t('places.noneYet')}</p>}
        <ul className="grid gap-2 sm:grid-cols-2">
          {states.data?.items.map((s) => (
            <li key={s.id}>
              <Link to={`/places/${s.id}`} className="flex items-center justify-between rounded-xl border border-stone-200 px-4 py-3 font-semibold hover:border-rose-300 hover:bg-rose-50">
                {localName(s.name, i18n.language)} <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-xs text-stone-500">{t('places.dataCredit')}</p>
    </div>
  );
}
