import {
  CreatePostFields,
  ErrorBody,
  POST_SUMMARY_MAX,
  type CreatePostResponse,
  type HeldPostsResponse,
  type Language,
  type LocationSummary,
  type MyPost,
  type MyPostsResponse,
  type PostHoldReason,
} from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, ApiError, errorCode, type ClientErrorCode } from '../api/client';
import { useCategories } from '../api/hooks';
import { Icon } from '../components/icons';
import { LocationPicker, TrustBadge } from '../components/news';
import { Alert, Button, Card, PageTitle, Select, StatusPill, TextArea, TextField } from '../components/ui';
import { formatDateTime, localName, locationLabel } from '../lib/format';

/**
 * Shrinks a phone photo before upload (phones produce 4–12 MB files; this sends a few hundred KB). Re-drawing it on a
 * canvas also drops the photo's metadata (GPS location) before it leaves the phone. The server cleans it again.
 */
async function shrinkPhoto(file: File, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85));
}

/** Multipart upload (the shared api() helper is JSON-only). Same-origin, so the session cookie and Origin go along. */
async function sendPost(form: FormData): Promise<CreatePostResponse> {
  let res: Response;
  try {
    res = await fetch('/api/v1/posts', { method: 'POST', body: form, credentials: 'same-origin', headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(data);
    if (parsed.success) throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    throw new ApiError(res.status, 'INTERNAL', `HTTP ${res.status}`);
  }
  return data as CreatePostResponse;
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function PostNewsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const categories = useCategories();
  const [location, setLocation] = useState<LocationSummary | null>(null);
  const [f, setF] = useState({ headline: '', summary: '', body: '', categoryId: '', language: (i18n.language === 'en' ? 'en' : 'te') as Language });
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [moreDetails, setMoreDetails] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [done, setDone] = useState<MyPost | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photo) return setPreview(null);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fields = { headline: f.headline, summary: f.summary, language: f.language, locationId: location?.id ?? '', categoryId: f.categoryId, ...(f.body.trim() ? { body: f.body } : {}) };
    const check = CreatePostFields.safeParse(fields);
    if (!check.success) {
      setErrors(Object.fromEntries(check.error.issues.map((i) => [String(i.path[0] ?? ''), i.path[0] === 'locationId' ? t('post.pickPlace') : i.path[0] === 'categoryId' ? t('post.pickTopic') : i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (photo) form.append('photo', await shrinkPhoto(photo).catch(() => photo), 'photo.jpg');
      const res = await sendPost(form);
      setDone(res.post);
      void qc.invalidateQueries({ queryKey: ['feed'] });
      void qc.invalidateQueries({ queryKey: ['posts'] });
    } catch (err) {
      const code = errorCode(err);
      if (err instanceof ApiError && err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      setError(code);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Alert kind="success">{t('post.live')}</Alert>
        <div className="flex flex-wrap gap-2">
          <Link to={`/articles/${done.slug}`} className="inline-flex min-h-11 items-center rounded-lg bg-rose-700 px-4 font-semibold text-white">
            {t('post.view')}
          </Link>
          <Button
            variant="secondary"
            onClick={() => {
              setDone(null);
              setF({ ...f, headline: '', summary: '', body: '' });
              setPhoto(null);
            }}
          >
            {t('post.another')}
          </Button>
          <Link to="/my-posts" className="inline-flex min-h-11 items-center px-3 text-rose-800 underline">
            {t('nav.myPosts')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageTitle>{t('post.title')}</PageTitle>
      <p className="mb-4 text-sm text-slate-700">{t('post.intro')}</p>
      {error && <Alert kind="error">{error === 'VALIDATION_FAILED' ? t('post.fixErrors') : t(`errors.${error}`)}</Alert>}
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <div className="mb-4">
            <span className="mb-1 block font-medium text-stone-800">{t('post.photo')}</span>
            <label
              htmlFor="post-photo"
              className={`relative flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed text-center ${preview ? 'border-transparent' : 'aspect-[16/10] border-stone-300 bg-stone-50 hover:border-rose-400 hover:bg-rose-50'}`}
            >
              {preview ? (
                <>
                  <img src={preview} alt={t('post.photoPreview')} className="aspect-[16/10] w-full object-cover" />
                  <span className="absolute right-2 bottom-2 rounded-full bg-stone-900/80 px-3 py-1 text-xs font-semibold text-white">{t('post.changePhoto')}</span>
                </>
              ) : (
                <>
                  <span className="mb-2 grid size-12 place-items-center rounded-full bg-rose-100 text-rose-600">
                    <Icon name="camera" />
                  </span>
                  <span className="font-semibold text-stone-800">{t('post.addPhoto')}</span>
                </>
              )}
              <input
                id="post-photo"
                aria-label={t('post.photo')}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </label>
            <p className="mt-1 text-sm text-stone-600">{t('post.photoHint')}</p>
            {errors.photo && <p className="mt-1 text-sm font-medium text-red-700">{errors.photo}</p>}
          </div>
          <TextField label={t('post.headline')} lang={f.language} value={f.headline} maxLength={120} error={errors.headline} hint={`${f.headline.length}/120`} onChange={(e) => setF({ ...f, headline: e.target.value })} />
          <TextArea
            label={t('post.summary')}
            lang={f.language}
            rows={4}
            value={f.summary}
            error={errors.summary}
            hint={t('post.summaryHint', { words: words(f.summary), chars: f.summary.length, max: POST_SUMMARY_MAX })}
            onChange={(v) => setF({ ...f, summary: v.slice(0, POST_SUMMARY_MAX) })}
          />
          {moreDetails ? (
            <TextArea label={t('post.body')} lang={f.language} rows={6} value={f.body} onChange={(v) => setF({ ...f, body: v })} />
          ) : (
            <button type="button" className="mb-4 text-sm text-rose-800 underline" onClick={() => setMoreDetails(true)}>
              {t('post.addDetails')}
            </button>
          )}
          <div className="mb-4">
            {location ? (
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t('post.place')}:</span> {locationLabel(location, i18n.language)}
                <button type="button" className="text-sm underline" onClick={() => setLocation(null)}>
                  {t('post.change')}
                </button>
              </p>
            ) : (
              <LocationPicker label={t('post.place')} onPick={setLocation} />
            )}
            {errors.locationId && <p className="mt-1 text-sm font-medium text-red-700">{errors.locationId}</p>}
          </div>
          <Select
            label={t('post.topic')}
            value={f.categoryId}
            options={[{ value: '', label: t('post.chooseTopic') }, ...(categories.data?.items ?? []).map((c) => ({ value: c.id, label: localName(c.name, i18n.language) }))]}
            onChange={(v) => setF({ ...f, categoryId: v })}
          />
          {errors.categoryId && <p className="-mt-3 mb-4 text-sm font-medium text-red-700">{errors.categoryId}</p>}
          <Select
            label={t('post.language')}
            value={f.language}
            options={[
              { value: 'te', label: t('languages.te') },
              { value: 'en', label: t('languages.en') },
            ]}
            onChange={(v) => setF({ ...f, language: v })}
          />
          <p className="mb-4 text-sm text-slate-600">{t('post.labelNote')}</p>
          <Button type="submit" busy={busy} className="w-full">
            {t('post.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

const HOLD_TONE: Record<PostHoldReason, 'amber' | 'red' | 'slate'> = { needs_review: 'amber', community_reports: 'red', author_deleted: 'slate', editor_removed: 'red' };

export function MyPostsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['posts', 'mine'], queryFn: () => api<MyPostsResponse>('GET', '/posts/mine') });
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (id: string) => {
    if (!window.confirm(t('myPosts.confirmDelete'))) return;
    setBusy(id);
    try {
      await api('DELETE', `/posts/${id}`);
      await qc.invalidateQueries({ queryKey: ['posts'] });
      void qc.invalidateQueries({ queryKey: ['feed'] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t('myPosts.title')}</PageTitle>
        <Link to="/post" className="inline-flex min-h-11 items-center rounded-lg bg-rose-700 px-4 font-semibold text-white">
          {t('nav.postNews')}
        </Link>
      </div>
      {q.isError && <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>}
      {q.data && !q.data.items.length && <p className="text-slate-600">{t('myPosts.empty')}</p>}
      {q.data?.items.map((p) => (
        <Card key={p.id}>
          <div className="flex gap-3">
            {p.imageUrl && <img src={p.imageUrl} alt="" className="h-20 w-28 shrink-0 rounded-lg object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <StatusPill tone={p.holdReason ? HOLD_TONE[p.holdReason] : 'emerald'}>{p.holdReason ? t(`myPosts.hold_${p.holdReason}`) : t('myPosts.live')}</StatusPill>
                <span className="text-slate-600">{formatDateTime(p.firstPublishedAt, i18n.language)}</span>
              </p>
              <h2 className="font-semibold leading-snug" lang={p.language}>
                {p.holdReason ? p.headline : <Link to={`/articles/${p.slug}`} className="hover:underline">{p.headline}</Link>}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {t('myPosts.reports', { count: p.openReports, max: q.data.removeAfterReports })}
              </p>
            </div>
          </div>
          {!p.holdReason && (
            <Button variant="secondary" className="mt-3" busy={busy === p.id} onClick={() => void remove(p.id)}>
              {t('myPosts.delete')}
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}

/** For editors on the moderation page: posts removed by readers' reports (restore one if the reports were unfair). */
export function HeldPostsPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const reason = 'community_reports';
  const q = useQuery({ queryKey: ['moderation', 'posts', reason], queryFn: () => api<HeldPostsResponse>('GET', `/moderation/posts?reason=${reason}`) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);

  const decide = async (id: string, decision: 'restore' | 'keep_removed') => {
    setError(null);
    try {
      await api('POST', `/moderation/posts/${id}/decide`, { decision, note: (notes[id] ?? '').trim() });
      await qc.invalidateQueries({ queryKey: ['moderation', 'posts'] });
    } catch (err) {
      setError(errorCode(err));
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t('heldPosts.title')}</h2>
      {error && <Alert kind="error">{error === 'VALIDATION_FAILED' ? t('heldPosts.noteNeeded') : t(`errors.${error}`)}</Alert>}
      {q.data && !q.data.items.length && <p className="text-slate-600">{t('heldPosts.none')}</p>}
      {q.data?.items.map((p) => (
        <Card key={p.id}>
          {p.imageUrl && <img src={p.imageUrl} alt="" className="mb-3 aspect-[16/10] w-full rounded-lg object-cover" />}
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <TrustBadge label={p.trustLabel} /> {p.author.displayName} · {locationLabel(p.location, i18n.language)} · {localName(p.category.name, i18n.language)}
          </p>
          <h3 className="font-semibold" lang={p.language}>
            {p.headline}
          </h3>
          <p className="mt-1 text-slate-700" lang={p.language}>
            {p.summary}
          </p>
          {Object.keys(p.reportReasons).length > 0 && (
            <p className="mt-2 text-sm">
              <strong>{t('heldPosts.reportedAs')}</strong> {Object.entries(p.reportReasons).map(([r, n]) => `${t(`reportReason.${r}`)} (${n})`).join(', ')}
            </p>
          )}
          <TextArea label={t('heldPosts.note')} rows={2} value={notes[p.id] ?? ''} onChange={(v) => setNotes({ ...notes, [p.id]: v })} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void decide(p.id, 'restore')}>{t('heldPosts.restore')}</Button>
            <Button variant="danger" onClick={() => void decide(p.id, 'keep_removed')}>
              {t('heldPosts.keepRemoved')}
            </Button>
          </div>
        </Card>
      ))}
    </section>
  );
}
