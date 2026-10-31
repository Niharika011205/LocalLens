import {
  LANGUAGES,
  type Language,
  type LocationSummary,
  type Submission,
  type SubmissionEvent,
  type SubmissionListResponse,
  type SubmissionResponse,
  type SubmissionStatus,
  type TrackRecordResponse,
} from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorCode, fieldErrors, type ClientErrorCode } from '../api/client';
import { useCategories } from '../api/hooks';
import { AppealBox, TrackRecordView } from '../components/Accountability';
import { LocationPicker } from '../components/news';
import { Alert, Button, Card, PageTitle, Select, StatusPill, TextArea, TextField } from '../components/ui';
import { formatDateTime, localName, locationLabel } from '../lib/format';

export const STATUS_TONE: Record<SubmissionStatus, 'slate' | 'amber' | 'red' | 'emerald' | 'sky'> = {
  draft: 'slate',
  submitted: 'sky',
  in_review: 'sky',
  needs_info: 'amber',
  returned: 'amber',
  rejected: 'red',
  published: 'emerald',
  withdrawn: 'slate',
};

export function Timeline({ events, viewer = 'reporter' }: { events: SubmissionEvent[]; viewer?: 'reporter' | 'editor' }) {
  const { t, i18n } = useTranslation();
  const by = (role: SubmissionEvent['actorRole']) => (role === 'reporter' && viewer === 'editor' ? t('timeline.by_reporter_other') : t(`timeline.by_${role}`));
  return (
    <ol className="space-y-3">
      {events.map((e, i) => (
        <li key={i} className="border-l-2 border-rose-200 pl-3 text-sm">
          <p className="font-semibold">
            {t(`timeline.${e.action}`, { defaultValue: e.action })}{' '}
            <span className="font-normal text-slate-500">
              · {by(e.actorRole)} · {formatDateTime(e.at, i18n.language)}
            </span>
          </p>
          {e.reasonCode && <p className="text-slate-700">{t(`rejection.${e.reasonCode}`, { defaultValue: e.reasonCode })}</p>}
          {e.note && <p className="whitespace-pre-line text-slate-700">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export function MySubmissionsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const list = useQuery({ queryKey: ['submissions', 'mine'], queryFn: () => api<SubmissionListResponse>('GET', '/submissions') });
  const track = useQuery({ queryKey: ['submissions', 'track-record'], queryFn: () => api<TrackRecordResponse>('GET', '/submissions/track-record') });

  const startNew = async () => {
    try {
      const res = await api<SubmissionResponse>('POST', '/submissions', {});
      navigate(`/reporter/submissions/${res.submission.id}`);
    } catch (err) {
      setError(errorCode(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t('reporter.title')}</PageTitle>
        <Button onClick={startNew}>{t('reporter.new')}</Button>
      </div>
      <p className="text-slate-700">{t('reporter.intro')}</p>
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      {track.data && (
        <Card>
          <h2 className="mb-2 font-semibold">{t('track.title')}</h2>
          <TrackRecordView record={track.data.trackRecord} own />
        </Card>
      )}
      <Card>
        {list.isPending && <p className="text-slate-500">{t('common.loading')}</p>}
        {list.isSuccess && !list.data.items.length && <p className="text-slate-600">{t('reporter.empty')}</p>}
        <ul className="divide-y divide-slate-200">
          {list.data?.items.map((s) => (
            <li key={s.id} className="py-3">
              <Link to={`/reporter/submissions/${s.id}`} className="font-semibold hover:underline" lang={s.language}>
                {s.headline || t('reporter.untitled')}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <StatusPill tone={STATUS_TONE[s.status]}>{t(`submissionStatus.${s.status}`)}</StatusPill>
                {s.location && <span>{locationLabel(s.location, i18n.language)}</span>}
                <span>· {formatDateTime(s.updatedAt, i18n.language)}</span>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

type DraftForm = {
  headline: string;
  summary: string;
  body: string;
  language: Language;
  categoryId: string;
  incidentDate: string;
  supportingUrls: string;
  editorContext: string;
};

function toForm(s: Submission): DraftForm {
  return {
    headline: s.headline,
    summary: s.summary,
    body: s.body,
    language: s.language,
    categoryId: s.category?.id ?? '',
    incidentDate: s.incidentDate ?? '',
    supportingUrls: s.supportingUrls.join('\n'),
    editorContext: s.editorContext,
  };
}

export function SubmissionEditorPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const categories = useCategories();
  const q = useQuery({ queryKey: ['submission', id], queryFn: () => api<SubmissionResponse>('GET', `/submissions/${id}`) });
  const [form, setForm] = useState<DraftForm | null>(null);
  const [location, setLocation] = useState<LocationSummary | null | undefined>(undefined);
  const [responseNote, setResponseNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) return <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>;
  const sub = q.data.submission;
  const editable = ['draft', 'returned', 'needs_info'].includes(sub.status);
  const f = form ?? toForm(sub);
  const loc = location === undefined ? sub.location : location;
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => setForm({ ...f, [k]: v });

  const payload = () => ({
    headline: f.headline,
    summary: f.summary,
    body: f.body,
    language: f.language,
    categoryId: f.categoryId || null,
    locationId: loc?.id ?? null,
    incidentDate: f.incidentDate || null,
    supportingUrls: f.supportingUrls.split(/\s+/).map((u) => u.trim()).filter(Boolean),
    editorContext: f.editorContext,
  });

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      setErrors({});
      setForm(null);
      setLocation(undefined);
      await qc.invalidateQueries({ queryKey: ['submission', id] });
      void qc.invalidateQueries({ queryKey: ['submissions'] });
      setMessage(done);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => void (await api('PATCH', `/submissions/${id}`, payload())), t('reporter.savedDraft'));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('PATCH', `/submissions/${id}`, payload());
      await api('POST', `/submissions/${id}/submit`, responseNote.trim() ? { responseNote: responseNote.trim() } : {});
      setResponseNote('');
    }, t('reporter.didSubmit'));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/reporter" className="text-rose-800 underline">
          ← {t('reporter.title')}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <PageTitle>{sub.headline || t('reporter.untitled')}</PageTitle>
        <StatusPill tone={STATUS_TONE[sub.status]}>{t(`submissionStatus.${sub.status}`)}</StatusPill>
      </div>
      <p className="text-sm text-slate-700">{t(`submissionStatusHelp.${sub.status}`)}</p>
      {sub.article && (
        <Alert kind="success">
          {t('reporter.publishedAs')}{' '}
          <Link to={`/articles/${sub.article.slug}`} className="font-semibold underline">
            {sub.article.headline}
          </Link>
        </Alert>
      )}
      {message && <Alert kind="success">{message}</Alert>}
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}

      {editable ? (
        <Card>
          <form onSubmit={submit} noValidate>
            <Select label={t('editor.language')} value={f.language} options={LANGUAGES.map((l) => ({ value: l, label: t(`languages.${l}`) }))} onChange={(v) => set('language', v)} />
            <TextField label={t('editor.headline')} lang={f.language} value={f.headline} error={errors.headline} onChange={(e) => set('headline', e.target.value)} />
            <TextArea label={t('editor.summary')} lang={f.language} rows={2} value={f.summary} error={errors.summary} onChange={(v) => set('summary', v)} />
            <TextArea label={t('reporter.whatHappened')} lang={f.language} rows={8} value={f.body} error={errors.body} onChange={(v) => set('body', v)} />
            {loc ? (
              <div className="mb-4">
                <p className="mb-1 font-medium text-slate-800">{t('editor.location')}</p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{locationLabel(loc, i18n.language)}</span>
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
              value={f.categoryId}
              error={errors.categoryId ? t('editor.pickCategory') : undefined}
              options={[{ value: '', label: '—' }, ...(categories.data?.items ?? []).map((c) => ({ value: c.id, label: localName(c.name, i18n.language) }))]}
              onChange={(v) => set('categoryId', v)}
            />
            <TextField label={t('reporter.incidentDate')} type="date" value={f.incidentDate} error={errors.incidentDate} onChange={(e) => set('incidentDate', e.target.value)} />
            <TextArea label={t('reporter.supportingUrls')} rows={3} value={f.supportingUrls} hint={t('reporter.supportingUrlsHint')} error={errors.supportingUrls} onChange={(v) => set('supportingUrls', v)} />
            <TextArea label={t('reporter.editorContext')} rows={3} value={f.editorContext} hint={t('reporter.editorContextHint')} onChange={(v) => set('editorContext', v)} />
            {sub.status !== 'draft' && <TextArea label={t('reporter.responseNote')} rows={2} value={responseNote} onChange={setResponseNote} />}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={busy}>
                {sub.status === 'draft' ? t('reporter.submit') : t('reporter.resubmit')}
              </Button>
              <Button type="button" variant="secondary" busy={busy} onClick={() => void save()}>
                {t('reporter.saveDraft')}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card>
          <p className="mb-2 text-lg font-semibold" lang={sub.language}>
            {sub.summary}
          </p>
          <p className="whitespace-pre-line text-slate-800" lang={sub.language}>
            {sub.body}
          </p>
        </Card>
      )}

      {['draft', 'submitted', 'needs_info', 'returned'].includes(sub.status) && (
        <Button variant="secondary" busy={busy} onClick={() => run(async () => void (await api('POST', `/submissions/${id}/withdraw`, {})), t('reporter.didWithdraw'))}>
          {t('reporter.withdraw')}
        </Button>
      )}

      {sub.status === 'rejected' && (sub.appeal || sub.appealUntil) && (
        <Card>
          <AppealBox sub={sub} onAppeal={(note) => run(async () => void (await api('POST', `/submissions/${id}/appeal`, { note })), t('appeals.sent'))} />
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('reporter.timeline')}</h2>
        <Timeline events={sub.timeline} />
      </Card>
    </div>
  );
}
