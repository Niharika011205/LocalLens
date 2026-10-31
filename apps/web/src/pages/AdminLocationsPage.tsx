import { childLevel, type LocationListResponse, type LocationResponse, type LocationSummary } from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, errorCode, type ClientErrorCode } from '../api/client';
import { Alert, Button, Card, PageTitle, TextField } from '../components/ui';
import { localName } from '../lib/format';

/**
 * Admins build the place hierarchy by hand (State → District → Mandal → Village). Every place is entered by a person
 * who knows it exists; the optional LGD code links it to the official directory for a later bulk import.
 */
export function AdminLocationsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [trail, setTrail] = useState<LocationSummary[]>([]);
  const parent = trail[trail.length - 1] ?? null;
  const level = childLevel(parent ? parent.level : null);

  const children = useQuery({
    queryKey: ['locations', 'children', parent?.id ?? 'root'],
    queryFn: () => api<LocationListResponse>('GET', parent ? `/locations?parentId=${parent.id}` : '/locations'),
  });

  const [form, setForm] = useState({ nameEn: '', nameTe: '', lgdCode: '', aliases: '' });
  const [error, setError] = useState<{ code: ClientErrorCode; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!level) return;
    setBusy(true);
    setError(null);
    try {
      await api<LocationResponse>('POST', '/admin/locations', {
        parentId: parent?.id ?? null,
        level,
        nameEn: form.nameEn,
        ...(form.nameTe.trim() ? { nameTe: form.nameTe } : {}),
        ...(form.lgdCode.trim() ? { lgdCode: form.lgdCode.trim() } : {}),
        ...(form.aliases.trim() ? { aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean) } : {}),
      });
      setForm({ nameEn: '', nameTe: '', lgdCode: '', aliases: '' });
      await qc.invalidateQueries({ queryKey: ['locations'] });
    } catch (err) {
      setError({ code: errorCode(err), message: err instanceof ApiError ? err.message : '' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageTitle>{t('adminPlaces.title')}</PageTitle>
      <p className="text-slate-700">{t('adminPlaces.intro')}</p>

      <nav aria-label={t('places.breadcrumb')} className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="text-rose-800 underline" onClick={() => setTrail([])}>
          {t('adminPlaces.top')}
        </button>
        {trail.map((l, i) => (
          <span key={l.id}>
            ›{' '}
            <button type="button" className="text-rose-800 underline" onClick={() => setTrail(trail.slice(0, i + 1))}>
              {localName(l.name, i18n.language)}
            </button>
          </span>
        ))}
      </nav>

      <Card>
        <h2 className="mb-2 font-semibold">
          {parent ? t('adminPlaces.inside', { place: localName(parent.name, i18n.language) }) : t('adminPlaces.states')}
        </h2>
        {children.isPending && <p className="text-slate-500">{t('common.loading')}</p>}
        {children.isSuccess && !children.data.items.length && <p className="text-slate-600">{t('adminPlaces.none')}</p>}
        <ul className="divide-y divide-slate-200">
          {children.data?.items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{c.name.en}</span>
                {c.name.te && <span className="text-slate-600"> · {c.name.te}</span>}
                {c.lgdCode && <span className="text-xs text-slate-500"> · LGD {c.lgdCode}</span>}
              </span>
              {childLevel(c.level) && (
                <Button variant="secondary" onClick={() => setTrail([...trail, c])}>
                  {t('adminPlaces.open')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {level && (
        <Card>
          <h2 className="mb-3 font-semibold">{t('adminPlaces.add', { level: t(`levels.${level}`) })}</h2>
          {error && <Alert kind="error">{error.message || t(`errors.${error.code}`)}</Alert>}
          <form onSubmit={onAdd} noValidate>
            <TextField label={t('adminPlaces.nameEn')} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            <TextField label={t('adminPlaces.nameTe')} lang="te" value={form.nameTe} onChange={(e) => setForm({ ...form, nameTe: e.target.value })} />
            <TextField
              label={t('adminPlaces.lgdCode')}
              inputMode="numeric"
              value={form.lgdCode}
              hint={t('adminPlaces.lgdHint')}
              onChange={(e) => setForm({ ...form, lgdCode: e.target.value })}
            />
            <TextField
              label={t('adminPlaces.aliases')}
              value={form.aliases}
              hint={t('adminPlaces.aliasesHint')}
              onChange={(e) => setForm({ ...form, aliases: e.target.value })}
            />
            <Button type="submit" busy={busy}>
              {t('adminPlaces.add', { level: t(`levels.${level}`) })}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
