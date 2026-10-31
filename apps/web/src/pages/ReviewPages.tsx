import {
  REJECTION_REASONS,
  EDITOR_TRUST_LABELS,
  type ContentReport,
  type RejectionReason,
  type SubmissionListResponse,
  type SubmissionResponse,
  type TrustLabel,
} from '@locallens/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api, ApiError, errorCode, type ClientErrorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { TrustBadge } from '../components/news';
import { VerificationPanel } from '../components/VerificationPanel';
import { TrackRecordView } from '../components/Accountability';
import { HeldPostsPanel } from './PostPages';
import { Alert, Button, Card, PageTitle, Select, StatusPill, TextArea, TextField } from '../components/ui';
import { formatDateTime, localName, locationLabel } from '../lib/format';
import { STATUS_TONE, Timeline } from './ReporterPages';

const QUEUE_TABS = ['submitted', 'in_review', 'needs_info', 'returned', 'rejected', 'published'] as const;

export function ReviewQueuePage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<(typeof QUEUE_TABS)[number]>('submitted');
  const list = useInfiniteQuery({
    queryKey: ['editorial', 'queue', status],
    queryFn: ({ pageParam }) => api<SubmissionListResponse>('GET', `/editorial/submissions?status=${status}&limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <PageTitle>{t('review.title')}</PageTitle>
      <p className="text-slate-700">{t('review.intro')}</p>
      <div role="group" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {QUEUE_TABS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`min-h-9 shrink-0 rounded-full border px-3 text-sm font-medium ${status === s ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white'}`}
          >
            {t(`submissionStatus.${s}`)}
          </button>
        ))}
      </div>
      <Card>
        {list.isPending && <p className="text-slate-500">{t('common.loading')}</p>}
        {list.isError && <Alert kind="error">{t(`errors.${errorCode(list.error)}`)}</Alert>}
        {list.isSuccess && !items.length && <p className="text-slate-600">{t('review.empty')}</p>}
        <ul className="divide-y divide-slate-200">
          {items.map((s) => (
            <li key={s.id} className="py-3">
              <Link to={`/editor/submissions/${s.id}`} className="font-semibold hover:underline" lang={s.language}>
                {s.headline}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                {s.riskLevel === 'high' && <StatusPill tone="red">{t('review.highRisk')}</StatusPill>}
                {s.origin === 'publisher' && <StatusPill tone="amber">{t('review.fromPublisher')}</StatusPill>}
                {s.possibleDuplicateCount > 0 && <StatusPill tone="sky">{t('review.duplicates', { count: s.possibleDuplicateCount })}</StatusPill>}
                {s.location && <span>{locationLabel(s.location, i18n.language)}</span>}
                {s.submittedAt && <span>· {formatDateTime(s.submittedAt, i18n.language)}</span>}
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

export function ReviewSubmissionPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['editorial', 'submission', id], queryFn: () => api<SubmissionResponse>('GET', `/editorial/submissions/${id}`) });
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<RejectionReason>('insufficient_evidence');
  const [trustLabel, setTrustLabel] = useState<TrustLabel>('citizen_reviewed');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<{ code: ClientErrorCode; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) return <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>;
  const s = q.data.submission;
  const senior = hasRole('senior_editor', 'admin');

  const act = async (path: string, body: object, msg: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api('POST', `/editorial/submissions/${s.id}/${path}`, body);
      setNote('');
      await qc.invalidateQueries({ queryKey: ['editorial'] });
      void qc.invalidateQueries({ queryKey: ['feed'] });
      setDone(msg);
    } catch (err) {
      setError({ code: errorCode(err), message: err instanceof ApiError ? err.message : '' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/editor/queue" className="text-rose-800 underline">
          ← {t('review.title')}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={STATUS_TONE[s.status]}>{t(`submissionStatus.${s.status}`)}</StatusPill>
        {s.riskLevel === 'high' && <StatusPill tone="red">{t('review.highRisk')}</StatusPill>}
        {s.origin === 'publisher' && <StatusPill tone="amber">{t('review.fromPublisher')}</StatusPill>}
        <StatusPill>{t(`aiStatus.${s.aiStatus}`)}</StatusPill>
      </div>
      <div lang={s.language}>
        <PageTitle>{s.headline}</PageTitle>
      </div>
      <p className="text-sm text-slate-600">
        {s.reporter && t('review.by', { name: s.reporter.displayName })} · {s.location && locationLabel(s.location, i18n.language)} ·{' '}
        {s.category && localName(s.category.name, i18n.language)} {s.incidentDate && `· ${t('reporter.incidentDate')}: ${s.incidentDate}`} · v{s.version}
      </p>

      {s.reporterTrackRecord && (
        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('track.reporterRecord')}</summary>
          <div className="mt-2">
            <TrackRecordView record={s.reporterTrackRecord} own={false} />
          </div>
        </details>
      )}
      {s.appeal && <Alert kind="info">{t('appeals.onSubmission', { status: t(`appeals.status_${s.appeal.status}`) })}</Alert>}

      {s.riskLevel === 'high' && (
        <Alert kind="info">
          {t('review.highRiskHelp')} {s.riskReasons.length > 0 && `(${s.riskReasons.map((r) => t(`riskReason.${r}`, { defaultValue: r })).join(', ')})`}
        </Alert>
      )}
      {s.possibleDuplicateIds.length > 0 && (
        <Alert kind="info">
          {t('review.duplicatesHelp')}{' '}
          {s.possibleDuplicateIds.map((d, i) => (
            <Link key={d} to={`/editor/submissions/${d}`} className="font-semibold underline">
              #{i + 1}{' '}
            </Link>
          ))}
        </Alert>
      )}
      {done && <Alert kind="success">{done}</Alert>}
      {error && <Alert kind="error">{error.message || t(`errors.${error.code}`)}</Alert>}

      <Card>
        <p className="mb-2 text-lg font-semibold" lang={s.language}>
          {s.summary}
        </p>
        <p className="whitespace-pre-line text-slate-900" lang={s.language}>
          {s.body}
        </p>
        {s.supportingUrls.length > 0 && (
          <div className="mt-4">
            <h2 className="font-semibold">{t('reporter.supportingUrls')}</h2>
            <ul className="list-disc pl-5 text-sm">
              {s.supportingUrls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-rose-800 underline">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.editorContext && (
          <div className="mt-4">
            <h2 className="font-semibold">{t('reporter.editorContext')}</h2>
            <p className="whitespace-pre-line text-sm text-slate-700">{s.editorContext}</p>
          </div>
        )}
      </Card>

      <VerificationPanel submissionId={s.id} />

      {s.status === 'submitted' && (
        <Button busy={busy} onClick={() => act('claim', {}, t('review.didClaim'))}>
          {t('review.claim')}
        </Button>
      )}

      {s.status === 'in_review' && (
        <>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('review.publishTitle')}</h2>
            {s.origin === 'publisher' ? (
              <p className="mb-3 text-sm text-slate-700">
                <TrustBadge label="official_unverified" /> {t('review.publisherLabel')}
              </p>
            ) : (
              <Select
                label={t('editor.trustLabel')}
                value={trustLabel}
                options={EDITOR_TRUST_LABELS.filter((l) => l !== 'official_unverified').map((l) => ({ value: l, label: t(`trust.${l}.short`) }))}
                onChange={setTrustLabel}
              />
            )}
            {s.riskLevel === 'high' && !senior ? (
              <p className="text-sm font-medium text-red-700">{t('review.needsSenior')}</p>
            ) : (
              <>
                <TextField label={t('editor.deadline')} type="date" value={deadline} hint={t('editor.deadlineHint')} onChange={(e) => setDeadline(e.target.value)} />
                <Button busy={busy} onClick={() => act('publish', { trustLabel, ...(deadline ? { deadline } : {}) }, t('review.didPublish'))}>
                  {t('editor.publish')}
                </Button>
              </>
            )}
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('review.respondTitle')}</h2>
            <TextArea label={t('review.noteToReporter')} rows={3} value={note} onChange={setNote} hint={t('review.noteHint')} />
            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant="secondary" busy={busy} onClick={() => act('request-info', { note }, t('review.didRequestInfo'))}>
                {t('review.requestInfo')}
              </Button>
              <Button variant="secondary" busy={busy} onClick={() => act('return', { note }, t('review.didReturn'))}>
                {t('review.return')}
              </Button>
            </div>
            <Select label={t('review.rejectReason')} value={reason} options={REJECTION_REASONS.map((r) => ({ value: r, label: t(`rejection.${r}`) }))} onChange={setReason} />
            <Button variant="danger" busy={busy} onClick={() => act('reject', { reasonCode: reason, note }, t('review.didReject'))}>
              {t('review.reject')}
            </Button>
          </Card>
        </>
      )}

      {!['published', 'rejected', 'withdrawn'].includes(s.status) && (
        <Card>
          <h2 className="mb-2 text-lg font-semibold">{t('review.riskTitle')}</h2>
          {s.riskLevel === 'normal' ? (
            <>
              <TextArea label={t('review.riskNote')} rows={2} value={note} onChange={setNote} />
              <Button variant="secondary" busy={busy} onClick={() => act('risk', { riskLevel: 'high', note }, t('review.didRaiseRisk'))}>
                {t('review.raiseRisk')}
              </Button>
            </>
          ) : senior ? (
            <>
              <TextArea label={t('review.riskNote')} rows={2} value={note} onChange={setNote} />
              <Button variant="secondary" busy={busy} onClick={() => act('risk', { riskLevel: 'normal', note }, t('review.didLowerRisk'))}>
                {t('review.lowerRisk')}
              </Button>
            </>
          ) : (
            <p className="text-sm text-slate-600">{t('review.onlySeniorLowers')}</p>
          )}
        </Card>
      )}

      {s.article && (
        <Alert kind="success">
          {t('reporter.publishedAs')}{' '}
          <Link to={`/articles/${s.article.slug}`} className="font-semibold underline">
            {s.article.headline}
          </Link>
        </Alert>
      )}

      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('reporter.timeline')}</h2>
        <Timeline events={s.timeline} viewer="editor" />
      </Card>
    </div>
  );
}

export function ModerationPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const list = useQuery({ queryKey: ['moderation', status], queryFn: () => api<{ items: ContentReport[] }>('GET', `/moderation/reports?status=${status}`) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);

  const resolve = async (id: string, outcome: 'actioned' | 'dismissed') => {
    setError(null);
    try {
      await api('POST', `/moderation/reports/${id}/resolve`, { outcome, note: notes[id] ?? '' });
      await qc.invalidateQueries({ queryKey: ['moderation'] });
    } catch (err) {
      setError(errorCode(err));
    }
  };

  return (
    <div className="space-y-4">
      <PageTitle>{t('moderation.title')}</PageTitle>
      <HeldPostsPanel />
      <h2 className="pt-2 text-lg font-semibold">{t('moderation.allReports')}</h2>
      <p className="text-slate-700">{t('moderation.intro')}</p>
      <div role="group" className="flex gap-2">
        {(['open', 'actioned', 'dismissed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`min-h-9 rounded-full border px-3 text-sm font-medium ${status === s ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white'}`}
          >
            {t(`moderation.status_${s}`)}
          </button>
        ))}
      </div>
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      <Card>
        {list.isSuccess && !list.data.items.length && <p className="text-slate-600">{t('moderation.empty')}</p>}
        <ul className="divide-y divide-slate-200">
          {list.data?.items.map((r) => (
            <li key={r.id} className="py-3">
              <Link to={`/articles/${r.article.slug}`} className="font-semibold hover:underline" lang={r.article.language}>
                {r.article.headline}
              </Link>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
                <StatusPill tone="amber">{t(`reportReason.${r.reason}`)}</StatusPill>
                <span>{t('moderation.count', { count: r.reportCountForArticle })}</span>
                <span>· {formatDateTime(r.createdAt, i18n.language)}</span>
              </div>
              {r.details && <p className="mt-1 text-sm text-slate-700">{r.details}</p>}
              {r.resolutionNote && <p className="mt-1 text-sm text-slate-600">✓ {r.resolutionNote}</p>}
              {r.status === 'open' && (
                <div className="mt-2">
                  <TextArea label={t('moderation.note')} rows={2} value={notes[r.id] ?? ''} onChange={(v) => setNotes({ ...notes, [r.id]: v })} />
                  <div className="flex flex-wrap gap-2">
                    <Link to={`/editor/articles/${r.article.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 font-semibold">
                      {t('moderation.openArticle')}
                    </Link>
                    <Button variant="secondary" onClick={() => resolve(r.id, 'actioned')}>
                      {t('moderation.actioned')}
                    </Button>
                    <Button variant="secondary" onClick={() => resolve(r.id, 'dismissed')}>
                      {t('moderation.dismiss')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
