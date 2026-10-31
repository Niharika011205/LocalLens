import type { AppealListResponse, AppealStatus, AuditResponse, OpsResponse } from '@locallens/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, ApiError, errorCode } from '../api/client';
import { Alert, Button, Card, PageTitle, StatusPill, TextArea, TextField } from '../components/ui';
import { formatDateTime } from '../lib/format';

// ---------- senior editors: appeals ----------
function AppealDecision({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (outcome: 'upheld' | 'overturned') => api('POST', `/editorial/appeals/${id}/decide`, { outcome, note: note.trim() }),
    onSuccess: onDone,
  });
  return (
    <div className="mt-3">
      <TextArea label={t('appeals.decisionNote')} rows={2} value={note} onChange={setNote} hint={t('appeals.decisionHint')} />
      {decide.isError && (
        <Alert kind="error">{decide.error instanceof ApiError && decide.error.code === 'FORBIDDEN' ? t('appeals.notYourOwn') : t(`errors.${errorCode(decide.error)}`)}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button busy={decide.isPending} disabled={note.trim().length < 5} onClick={() => decide.mutate('overturned')}>
          {t('appeals.overturn')}
        </Button>
        <Button variant="secondary" busy={decide.isPending} disabled={note.trim().length < 5} onClick={() => decide.mutate('upheld')}>
          {t('appeals.uphold')}
        </Button>
      </div>
    </div>
  );
}

export function AppealsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<AppealStatus>('open');
  const q = useQuery({ queryKey: ['appeals', status], queryFn: () => api<AppealListResponse>('GET', `/editorial/appeals?status=${status}`) });
  return (
    <div className="space-y-4">
      <PageTitle>{t('appeals.queueTitle')}</PageTitle>
      <p className="text-slate-700">{t('appeals.queueIntro')}</p>
      <div role="tablist" className="flex gap-2">
        {(['open', 'overturned', 'upheld'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} type="button" onClick={() => setStatus(s)} className={`rounded-full px-3 py-1 text-sm font-medium ${status === s ? 'bg-rose-700 text-white' : 'border border-slate-300 bg-white'}`}>
            {t(`appeals.tab_${s}`)}
          </button>
        ))}
      </div>
      {q.isError && <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>}
      {q.data && !q.data.items.length && <p className="text-slate-600">{t('appeals.none')}</p>}
      {q.data?.items.map((a) => (
        <Card key={a.id}>
          <p className="text-sm text-slate-600">
            {a.reporter?.displayName} · {formatDateTime(a.createdAt, i18n.language)}
          </p>
          <h2 className="font-semibold">
            <Link to={`/editor/submissions/${a.submission.id}`} className="text-rose-800 underline">
              {a.submission.headline}
            </Link>
          </h2>
          <p className="mt-2 text-sm">
            <strong>{t('appeals.rejectedFor')}</strong> {a.submission.reasonCode && t(`rejection.${a.submission.reasonCode}`)}
            {a.submission.rejectionNote && <span className="block text-slate-700">{a.submission.rejectionNote}</span>}
          </p>
          <p className="mt-2 text-sm">
            <strong>{t('appeals.reporterSays')}</strong>
            <span className="block whitespace-pre-line text-slate-700">{a.note}</span>
          </p>
          {a.status === 'open' ? (
            <AppealDecision id={a.id} onDone={() => void qc.invalidateQueries({ queryKey: ['appeals'] })} />
          ) : (
            <p className="mt-2 text-sm">
              <StatusPill tone={a.status === 'overturned' ? 'emerald' : 'slate'}>{t(`appeals.status_${a.status}`)}</StatusPill> {a.decisionNote}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

// ---------- admin: operations ----------
function Stat({ label, value, warn = false }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${warn ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="text-sm text-slate-600">{label}</p>
    </div>
  );
}

export function AdminOpsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'ops'], queryFn: () => api<OpsResponse>('GET', '/admin/ops'), refetchInterval: 30_000 });
  const retry = useMutation({ mutationFn: (id: string) => api('POST', `/admin/jobs/${id}/retry`, {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'ops'] }) });
  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) return <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>;
  const o = q.data;
  const waiting = (o.newsroom.byStatus.submitted ?? 0) + (o.newsroom.byStatus.in_review ?? 0);
  return (
    <div className="space-y-4">
      <PageTitle>{t('ops.title')}</PageTitle>
      <p className="text-sm text-slate-600">{t('ops.updated', { at: formatDateTime(o.generatedAt, i18n.language) })}</p>

      <h2 className="text-lg font-semibold">{t('ops.newsroom')}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('ops.waiting')} value={waiting} />
        <Stat label={t('ops.oldestWaiting')} value={o.newsroom.oldestWaitingHours === null ? '—' : `${o.newsroom.oldestWaitingHours} h`} warn={(o.newsroom.oldestWaitingHours ?? 0) > 24} />
        <Stat label={t('ops.highRisk')} value={o.newsroom.highRiskWaiting} warn={o.newsroom.highRiskWaiting > 0} />
        <Stat label={t('ops.openAppeals')} value={o.newsroom.openAppeals} />
        <Stat label={t('ops.openReports')} value={o.newsroom.openReports} warn={o.newsroom.openReports > 0} />
        <Stat label={t('ops.pendingReporters')} value={o.users.pendingReporterRequests} />
      </div>

      <h2 className="text-lg font-semibold">{t('ops.articles')}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('ops.published')} value={o.articles.published} />
        <Stat label={t('ops.published7')} value={o.articles.publishedLast7Days} />
        <Stat label={t('ops.corrections7')} value={o.articles.correctionsLast7Days} />
        <Stat label={t('ops.retracted')} value={o.articles.retracted} />
      </div>

      <h2 className="text-lg font-semibold">{t('ops.background')}</h2>
      <Card>
        <p className="mb-2 text-sm">
          {t('ops.ai')}: <StatusPill tone={o.ai.configured ? 'emerald' : 'slate'}>{o.ai.configured ? t('ops.aiOn') : t('ops.aiOff')}</StatusPill>{' '}
          {Object.entries(o.ai.verificationsLast7Days).map(([s, n]) => `${t(`aiStatus.${s}`, { defaultValue: s })}: ${n}`).join(' · ')}
          {' · '}
          {t('ops.cachedAnswers', { count: o.ai.assistantCachedAnswers })} · {t('ops.alerts24', { count: o.notificationsLast24Hours })}
        </p>
        {o.jobs.breakersOpen.length > 0 && <Alert kind="error">{t('ops.breakers', { types: o.jobs.breakersOpen.join(', ') })}</Alert>}
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t('ops.jobs')}</caption>
          <thead>
            <tr className="border-b border-slate-200">
              <th className="py-1 font-semibold">{t('ops.jobType')}</th>
              <th className="py-1 font-semibold">{t('ops.jobStatus')}</th>
              <th className="py-1 text-right font-semibold">{t('ops.count')}</th>
            </tr>
          </thead>
          <tbody>
            {o.jobs.byTypeAndStatus.map((j) => (
              <tr key={`${j.type}:${j.status}`} className="border-b border-slate-100">
                <td className="py-1 font-mono text-xs">{j.type}</td>
                <td className="py-1">{j.status}</td>
                <td className="py-1 text-right tabular-nums">{j.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {o.jobs.problems.length > 0 && (
        <Card>
          <h3 className="mb-2 font-semibold">{t('ops.problems')}</h3>
          <ul className="divide-y divide-slate-200 text-sm">
            {o.jobs.problems.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-mono text-xs">{j.type}</span> · {j.status} · {t('ops.attempts', { count: j.attempts })}
                  {j.lastError && <span className="block text-red-700">{j.lastError}</span>}
                </span>
                <Button variant="secondary" busy={retry.isPending} onClick={() => retry.mutate(j.id)}>
                  {t('ops.retry')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------- admin: audit log ----------
export function AdminAuditPage() {
  const { t, i18n } = useTranslation();
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', applied],
    queryFn: ({ pageParam }) =>
      api<AuditResponse>('GET', `/admin/audit?limit=50${applied ? `&action=${encodeURIComponent(applied)}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <PageTitle>{t('audit.title')}</PageTitle>
      <p className="text-slate-700">{t('audit.intro')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(action.trim());
        }}
      >
        <div className="min-w-60 flex-1">
          <TextField label={t('audit.action')} value={action} hint={t('audit.actionHint')} onChange={(e) => setAction(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary" className="mb-4">
          {t('audit.filter')}
        </Button>
      </form>
      {q.isError && <Alert kind="error">{t(`errors.${errorCode(q.error)}`)}</Alert>}
      <Card>
        {q.isSuccess && !items.length && <p className="text-slate-600">{t('audit.none')}</p>}
        <ul className="divide-y divide-slate-200 text-sm">
          {items.map((e) => (
            <li key={e.id} className="py-2">
              <p>
                <span className="font-mono text-xs font-semibold">{e.action}</span> · <time dateTime={e.at}>{formatDateTime(e.at, i18n.language)}</time>
              </p>
              <p className="text-slate-700">
                {e.actor ? `${e.actor.displayName} <${e.actor.email}>` : t('audit.system')}
                {e.targetType && ` → ${e.targetType} ${e.targetId ?? ''}`}
                {e.ip && <span className="text-slate-500"> · {e.ip}</span>}
              </p>
              {Object.keys(e.metadata).length > 0 && <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(e.metadata)}</pre>}
            </li>
          ))}
        </ul>
        {q.hasNextPage && (
          <Button variant="secondary" className="mt-3" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('feed.loadMore')}
          </Button>
        )}
      </Card>
    </div>
  );
}
