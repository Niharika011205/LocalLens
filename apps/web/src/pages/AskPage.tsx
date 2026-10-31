import type { LocationResponse } from '@locallens/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api } from '../api/client';
import { AssistantPanel, useAssistantEnabled } from '../components/AssistantPanel';
import { LocationPicker } from '../components/news';
import { Alert, PageTitle } from '../components/ui';
import { localName } from '../lib/format';

/** Ask about local news, optionally limited to one place (?place=<id>, so place pages can link here). */
export function AskPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const placeId = params.get('place') ?? undefined;
  const assistant = useAssistantEnabled();
  const place = useQuery({
    queryKey: ['location', placeId],
    queryFn: () => api<LocationResponse>('GET', `/locations/${placeId}`),
    enabled: !!placeId,
  });

  if (!assistant) {
    return (
      <div className="space-y-4">
        <PageTitle>{t('assistant.pageTitle')}</PageTitle>
        <Alert kind="info">{t('assistant.notAvailable')}</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageTitle>{t('assistant.pageTitle')}</PageTitle>
      <div className="flex flex-wrap items-center gap-2 text-slate-700">
        {placeId && place.data ? (
          <>
            <span>{t('assistant.limitedTo', { place: localName(place.data.location.name, i18n.language) })}</span>
            <button type="button" className="text-sm underline" onClick={() => setParams({})}>
              {t('assistant.allPlaces')}
            </button>
          </>
        ) : (
          <div className="w-full">
            <LocationPicker label={t('assistant.pickPlace')} onPick={(loc) => setParams({ place: loc.id })} />
          </div>
        )}
      </div>
      <AssistantPanel key={placeId ?? 'all'} {...(placeId ? { locationId: placeId } : {})} />
    </div>
  );
}
