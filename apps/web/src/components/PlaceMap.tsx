import type { LocationMapResponse } from '@locallens/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';

/**
 * A small map of the place (OpenStreetMap tiles via Leaflet, loaded only when a map is shown) plus an
 * "Open in Google Maps" link. The position comes from our API, which looks each place up once and caches it.
 */
export function PlaceMap({ locationId, name }: { locationId: string; name: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['location', locationId, 'map'], queryFn: () => api<LocationMapResponse>('GET', `/locations/${locationId}/map`), staleTime: Infinity });
  const box = useRef<HTMLDivElement>(null);
  const map = q.data?.map;

  useEffect(() => {
    if (!map || !box.current) return;
    let cancelled = false;
    let instance: { remove: () => void } | null = null;
    void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
      if (cancelled || !box.current) return;
      const m = L.map(box.current, { scrollWheelZoom: false, attributionControl: true }).setView([map.lat, map.lon], map.zoom);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);
      // A circle marker needs no image files (Leaflet's default pin images do not survive bundling).
      L.circleMarker([map.lat, map.lon], { radius: 9, color: '#e11d48', weight: 3, fillColor: '#fb7185', fillOpacity: 0.7 }).addTo(m).bindTooltip(name);
      instance = m;
    });
    return () => {
      cancelled = true;
      instance?.remove();
    };
  }, [map, name]);

  if (!q.data) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      {map ? (
        <div ref={box} className="h-56 w-full bg-stone-100 sm:h-72" role="img" aria-label={t('places.mapOf', { place: name })} />
      ) : (
        <p className="p-4 text-sm text-stone-600">{t('places.noMap')}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 px-4 py-2.5 text-sm">
        <span className="text-xs text-stone-500">{map ? t('places.mapCredit') : ''}</span>
        <a href={q.data.googleMapsUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-rose-700 hover:underline">
          {t('places.openInGoogleMaps')} ↗
        </a>
      </div>
    </div>
  );
}
