import {
  CreateArticleRequest,
  LANGUAGES,
  SOURCE_TYPES,
  EDITOR_TRUST_LABELS,
  type ArticleListResponse,
  type ArticleResponse,
  type ArticleStatus,
  type Language,
  type LocationSummary,
  type SourceType,
  type TrustLabel,
} from '@locallens/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorCode, fieldErrors, type ClientErrorCode } from '../api/client';
import { useCategories } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { LocationPicker, TrustBadge } from '../components/news';
import { Alert, Button, Card, PageTitle, Select, TextArea, TextField } from '../components/ui';
import { formatDateTime, localName, locationLabel } from '../lib/format';


// ------------------------------------------------------------------------------------------------------------

export function EditorListPage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<ArticleStatus | ''>('');
  const list = useInfiniteQuery({
    queryKey: ['editorial', 'list', status],
    queryFn: ({ pageParam }) =>
      api<ArticleListResponse>('GET', `/editorial/articles?limit=20${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t('editor.title')}</PageTitle>
        <Link to="/editor/new" className="inline-flex min-h-11 items-center rounded-lg bg-rose-700 px-4 font-semibold text-white">
          {t('editor.new')}
        </Link>
      </div>
      <div role="group" className="flex flex-wrap gap-2">
        {(['', 'published', 'unpublished', 'retracted'] as const).map((s) => (
          <button
            key={s || 'all'}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`min-h-9 rounded-full border px-3 text-sm font-medium ${status === s ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white'}`}
          >
            {s ? t(`articleStatus.${s}`) : t('editor.all')}
          </button>
        ))}
      </div>
      <Card>
        {list.isPending && <p className="text-slate-500">{t('common.loading')}</p>}
        {list.isError && <Alert kind="error">{t(`errors.${errorCode(list.error)}`)}</Alert>}
        {list.isSuccess && !items.length && <p className="text-slate-600">{t('editor.empty')}</p>}
        <ul>
          {items.map((a) => (
            <li key={a.id} className="border-b border-slate-200 py-3 last:border-0">
              <Link to={`/editor/articles/${a.id}`} className="font-semibold hover:underline" lang={a.language}>
                {a.headline}
              </Link>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold">{t(`articleStatus.${a.status}`)}</span>
                <span>{locationLabel(a.location, i18n.language)}</span>
                <span>· {formatDateTime(a.firstPublishedAt, i18n.language)}</span>
              </div>
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('feed.loadMore')}
          </Button>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------

export function NewArticlePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const categories = useCategories();
  const [location, setLocation] = useState<LocationSummary | null>(null);
  const [form, setForm] = useState({
    headline: '',
    summary: '',
    body: '',
    language: (i18n.language === 'en' ? 'en' : 'te') as Language,
    categoryId: '',
    trustLabel: 'citizen_reviewed' as TrustLabel,
    sourceType: 'staff' as SourceType,
    originalSourceUrl: '',
    deadline: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      ...form,
      locationId: location?.id ?? '',
      categoryId: form.categoryId,
      originalSourceUrl: form.originalSourceUrl.trim() || undefined,
      deadline: form.deadline || undefined,
    };
    const parsed = CreateArticleRequest.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? ''), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await api<ArticleResponse>('POST', '/editorial/articles', parsed.data);
      void qc.invalidateQueries({ queryKey: ['feed'] });
      void qc.invalidateQueries({ queryKey: ['editorial'] });
      navigate(`/articles/${res.article.slug}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageTitle>{t('editor.new')}</PageTitle>
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <Select
            label={t('editor.language')}
            value={form.language}
            options={LANGUAGES.map((l) => ({ value: l, label: t(`languages.${l}`) }))}
            onChange={(v) => set('language', v)}
          />
          <TextField label={t('editor.headline')} lang={form.language} value={form.headline} error={errors.headline} onChange={(e) => set('headline', e.target.value)} />
          <TextArea label={t('editor.summary')} lang={form.language} rows={2} value={form.summary} error={errors.summary} onChange={(v) => set('summary', v)} />
          <TextArea label={t('editor.body')} lang={form.language} rows={10} value={form.body} error={errors.body} onChange={(v) => set('body', v)} />

          {location ? (
            <div className="mb-4">
              <span className="mb-1 block font-medium text-slate-800">{t('editor.location')}</span>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{locationLabel(location, i18n.language)}</span>
                <button type="button" className="text-sm text-rose-800 underline" onClick={() => setLocation(null)}>
                  {t('editor.change')}
                </button>
              </p>
            </div>
          ) : (
            <>
              <LocationPicker label={t('editor.location')} onPick={setLocation} />
              {errors.locationId && <p className="-mt-3 mb-4 text-sm font-medium text-red-700">{t('editor.pickLocation')}</p>}
            </>
          )}

          <Select
            label={t('editor.category')}
            value={form.categoryId}
            options={[{ value: '', label: '—' }, ...(categories.data?.items ?? []).map((c) => ({ value: c.id, label: localName(c.name, i18n.language) }))]}
            onChange={(v) => set('categoryId', v)}
          />
          {errors.categoryId && <p className="-mt-3 mb-4 text-sm font-medium text-red-700">{t('editor.pickCategory')}</p>}

          <Select
            label={t('editor.sourceType')}
            value={form.sourceType}
            options={SOURCE_TYPES.map((s) => ({ value: s, label: t(`sourceType.${s}`) }))}
            onChange={(v) => set('sourceType', v)}
          />
          <Select
            label={t('editor.trustLabel')}
            value={form.trustLabel}
            options={EDITOR_TRUST_LABELS.map((s) => ({ value: s, label: t(`trust.${s}.short`) }))}
            onChange={(v) => set('trustLabel', v)}
          />
          <p className="-mt-2 mb-4 text-sm text-slate-600">{t(`trust.${form.trustLabel}.long`)}</p>
          <TextField
            label={t('editor.originalSourceUrl')}
            type="url"
            inputMode="url"
            value={form.originalSourceUrl}
            error={errors.originalSourceUrl}
            hint={t('editor.originalSourceHint')}
            onChange={(e) => set('originalSourceUrl', e.target.value)}
          />
          <TextField label={t('editor.deadline')} type="date" value={form.deadline} error={errors.deadline} hint={t('editor.deadlineHint')} onChange={(e) => set('deadline', e.target.value)} />
          <Button type="submit" busy={busy} className="w-full">
            {t('editor.publish')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------

function ActionForm({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

export function EditArticlePage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['editorial', 'article', id], queryFn: () => api<ArticleResponse>('GET', `/editorial/articles/${id}`) });
  const [revision, setRevision] = useState<{
    changeKind: 'update' | 'correction' | 'clarification';
    headline: string;
    summary: string;
    body: string;
    deadline: string;
    publicNote: string;
  } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<{ code: ClientErrorCode; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) return <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>;
  const a = q.data.article;
  const current = revision ?? { changeKind: 'update' as const, headline: a.headline, summary: a.summary, body: a.body ?? '', deadline: a.deadline ?? '', publicNote: '' };

  const act = async (path: string, body: object | undefined, doneMsg: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api('POST', `/editorial/articles/${a.id}/${path}`, body);
      await qc.invalidateQueries({ queryKey: ['editorial'] });
      void qc.invalidateQueries({ queryKey: ['feed'] });
      void qc.invalidateQueries({ queryKey: ['article', a.slug] });
      setRevision(null);
      setNote('');
      setDone(doneMsg);
    } catch (err) {
      setError({ code: errorCode(err), message: err instanceof ApiError ? err.message : '' });
    } finally {
      setBusy(false);
    }
  };

  const onRevise = (e: FormEvent) => {
    e.preventDefault();
    const changed = {
      ...(current.headline !== a.headline ? { headline: current.headline } : {}),
      ...(current.summary !== a.summary ? { summary: current.summary } : {}),
      ...(current.body !== (a.body ?? '') ? { body: current.body } : {}),
      ...(current.deadline !== (a.deadline ?? '') ? { deadline: current.deadline || null } : {}),
    };
    void act('revisions', { changeKind: current.changeKind, ...changed, ...(current.publicNote.trim() ? { publicNote: current.publicNote.trim() } : {}) }, t('editor.savedRevision'));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/editor" className="text-rose-800 underline">
          ← {t('editor.title')}
        </Link>
      </p>
      <PageTitle>{a.headline}</PageTitle>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold">{t(`articleStatus.${a.status}`)}</span>
        <TrustBadge label={a.trustLabel} />
        <span>{locationLabel(a.location, i18n.language)}</span>
        {a.status !== 'unpublished' && (
          <Link to={`/articles/${a.slug}`} className="text-rose-800 underline">
            {t('editor.viewPublic')}
          </Link>
        )}
      </div>
      {done && <Alert kind="success">{done}</Alert>}
      {error && <Alert kind="error">{error.code === 'CONFLICT' || error.code === 'VALIDATION_FAILED' ? error.message || t(`errors.${error.code}`) : t(`errors.${error.code}`)}</Alert>}

      {a.status !== 'retracted' && (
        <ActionForm title={t('editor.revise')}>
          <form onSubmit={onRevise} noValidate>
            <Select
              label={t('editor.changeKind')}
              value={current.changeKind}
              options={(['update', 'correction', 'clarification'] as const).map((k) => ({ value: k, label: t(`changeKind.${k}`) }))}
              onChange={(v) => setRevision({ ...current, changeKind: v })}
            />
            <TextField label={t('editor.headline')} lang={a.language} value={current.headline} onChange={(e) => setRevision({ ...current, headline: e.target.value })} />
            <TextArea label={t('editor.summary')} lang={a.language} rows={2} value={current.summary} onChange={(v) => setRevision({ ...current, summary: v })} />
            <TextArea label={t('editor.body')} lang={a.language} rows={8} value={current.body} onChange={(v) => setRevision({ ...current, body: v })} />
            <TextField
              label={t('editor.deadline')}
              type="date"
              value={current.deadline}
              hint={a.deadline ? t('editor.deadlineChangeHint') : t('editor.deadlineHint')}
              onChange={(e) => setRevision({ ...current, deadline: e.target.value })}
            />
            <TextArea label={t('editor.publicNote')} rows={2} value={current.publicNote} onChange={(v) => setRevision({ ...current, publicNote: v })} />
            <p className="-mt-2 mb-4 text-sm text-slate-600">{t('editor.publicNoteHint')}</p>
            <Button type="submit" busy={busy}>
              {t('editor.saveRevision')}
            </Button>
          </form>
        </ActionForm>
      )}

      {a.status !== 'retracted' && (
        <ActionForm title={a.status === 'published' ? t('editor.unpublish') : t('editor.republish')}>
          {a.status === 'published' ? (
            <>
              <TextArea label={t('editor.internalReason')} rows={2} value={note} onChange={setNote} />
              <Button variant="secondary" busy={busy} onClick={() => act('unpublish', { reason: note }, t('editor.didUnpublish'))}>
                {t('editor.unpublish')}
              </Button>
            </>
          ) : (
            <Button busy={busy} onClick={() => act('republish', undefined, t('editor.didRepublish'))}>
              {t('editor.republish')}
            </Button>
          )}
        </ActionForm>
      )}

      {a.status !== 'retracted' && hasRole('senior_editor', 'admin') && (
        <ActionForm title={t('editor.retract')}>
          <p className="mb-3 text-sm text-slate-700">{t('editor.retractHint')}</p>
          <TextArea label={t('editor.publicNote')} rows={2} value={note} onChange={setNote} />
          <Button variant="danger" busy={busy} onClick={() => act('retract', { publicNote: note }, t('editor.didRetract'))}>
            {t('editor.retract')}
          </Button>
        </ActionForm>
      )}

      <ActionForm title={t('article.history')}>
        <ol className="space-y-2 text-sm">
          {a.history.map((h) => (
            <li key={h.revisionNumber}>
              <span className="font-semibold">
                #{h.revisionNumber} {t(`changeKind.${h.changeKind}`)}
              </span>{' '}
              · {formatDateTime(h.createdAt, i18n.language)}
              {h.publicNote && <p className="text-slate-700">{h.publicNote}</p>}
            </li>
          ))}
        </ol>
      </ActionForm>
    </div>
  );
}
