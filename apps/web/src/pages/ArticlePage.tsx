import { REPORT_REASONS, type ArticleResponse, type ReportReason, type SavedStatusResponse } from '@locallens/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api, ApiError, errorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { AssistantPanel } from '../components/AssistantPanel';
import { NewsImage } from '../components/NewsImage';
import { ShareButton } from '../components/ShareButton';
import { summaryAddsSomething } from '../components/Shorts';
import { TrustBadge } from '../components/news';
import { Alert, Button, Card, PageTitle, Select, TextArea } from '../components/ui';
import { formatDate, formatDateTime, localName, locationLabel } from '../lib/format';

function SaveButton({ articleId }: { articleId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['saved', articleId],
    queryFn: () => api<SavedStatusResponse>('GET', `/me/saved/${articleId}`),
  });
  const toggle = useMutation({
    mutationFn: (save: boolean) => api(save ? 'PUT' : 'DELETE', `/me/saved/${articleId}`, save ? {} : undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['saved'] });
    },
  });
  const saved = status.data?.saved ?? false;
  return (
    <Button variant="secondary" busy={toggle.isPending || status.isPending} aria-pressed={saved} onClick={() => toggle.mutate(!saved)}>
      {saved ? t('article.saved') : t('article.save')}
    </Button>
  );
}

function ReportForm({ articleId }: { articleId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>('misleading');
  const [details, setDetails] = useState('');
  const [state, setState] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="text-sm text-slate-600 underline" onClick={() => setOpen(true)}>
        {t('report.open')}
      </button>
    );
  }
  const send = async () => {
    setBusy(true);
    try {
      await api('POST', `/articles/${articleId}/reports`, details.trim() ? { reason, details: details.trim() } : { reason });
      setState({ kind: 'success', text: t('report.thanks') });
    } catch (err) {
      setState({ kind: 'error', text: errorCode(err) === 'CONFLICT' ? t('report.already') : t(`errors.${errorCode(err)}`) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <h2 className="mb-2 font-semibold">{t('report.title')}</h2>
      {state ? (
        <Alert kind={state.kind}>{state.text}</Alert>
      ) : (
        <>
          <Select label={t('report.reason')} value={reason} options={REPORT_REASONS.map((r) => ({ value: r, label: t(`reportReason.${r}`) }))} onChange={setReason} />
          <TextArea label={t('report.details')} rows={3} value={details} onChange={setDetails} />
          <Button variant="secondary" busy={busy} onClick={() => void send()}>
            {t('report.send')}
          </Button>
        </>
      )}
    </Card>
  );
}

export function ArticlePage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['article', slug],
    queryFn: () => api<ArticleResponse>('GET', `/articles/${encodeURIComponent(slug)}`),
    retry: false,
  });

  useEffect(() => {
    if (q.data) document.title = `${q.data.article.headline} · LocalLens`;
    return () => {
      document.title = 'LocalLens';
    };
  }, [q.data]);

  if (q.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <Alert kind="error">{notFound ? t('article.notFound') : t(`errors.${errorCode(q.error)}`)}</Alert>;
  }

  const a = q.data.article;
  const retraction = a.history.find((h) => h.changeKind === 'retraction');
  return (
    <article className="space-y-4">
      <NewsImage src={a.imageUrl} className="aspect-[16/10] w-full rounded-2xl bg-stone-100 object-cover" />
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="font-semibold text-rose-800">{localName(a.category.name, i18n.language)}</span>
        <span aria-hidden="true">·</span>
        <Link to={`/places/${a.location.id}`} className="underline">
          {locationLabel(a.location, i18n.language)}
        </Link>
      </div>
      <div lang={a.language}>
        <PageTitle>{a.headline}</PageTitle>
      </div>

      {a.status === 'retracted' && (
        <Alert kind="error">
          <strong>{t('article.retracted')}</strong> {retraction?.publicNote}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <TrustBadge label={a.trustLabel} />
        <span>
          {t('article.published')} {formatDateTime(a.firstPublishedAt, i18n.language)}
        </span>
        {a.lastUpdatedAt !== a.firstPublishedAt && (
          <span>
            · {t('article.updated')} {formatDateTime(a.lastUpdatedAt, i18n.language)}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-600">
        {t(`trust.${a.trustLabel}.long`)} {a.sourceType !== 'external' && t(`source.${a.sourceType}`)}
      </p>

      {summaryAddsSomething(a) && (
        <p className="text-lg font-medium text-slate-800" lang={a.language}>
          {a.summary}
        </p>
      )}
      {/* Short posts and imported headlines have no separate body: don't show the same text twice. */}
      {a.body && a.body.trim() !== a.summary.trim() && (
        <div className="space-y-3 text-slate-900" lang={a.language}>
          {a.body.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="whitespace-pre-line">
              {para}
            </p>
          ))}
        </div>
      )}

      {a.externalSource && (
        <p className="rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-700">
          <span className="font-semibold text-stone-900">{t('article.sourceCredit', { site: a.externalSource.name })}</span>
          <span className="mt-1 block text-xs text-stone-500">
            {t('article.sourceNote')}{' '}
            {/* Attribution: a quiet credit link to the original, as publishers expect. Readers stay here by default. */}
            <a href={a.externalSource.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
              {new URL(a.externalSource.url).hostname.replace(/^www\./, '')}
            </a>
          </span>
        </p>
      )}

      {a.originalSourceUrl && !a.externalSource && (
        <p>
          <a href={a.originalSourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-rose-800 underline">
            {t('article.originalSource')}
          </a>
        </p>
      )}

      {a.deadline && (
        <Alert kind="info">
          {t('article.deadline')} <strong>{formatDate(`${a.deadline}T00:00:00+05:30`, i18n.language)}</strong>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {user && <SaveButton articleId={a.id} />}
        <ShareButton article={a} className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-4 font-semibold text-stone-800 hover:bg-stone-50" />
      </div>

      <Card>
        <h2 className="mb-2 text-lg font-semibold">{t('article.history')}</h2>
        <ol className="space-y-2">
          {a.history.map((h) => (
            <li key={h.revisionNumber} className="text-sm">
              <span className="font-semibold">{t(`changeKind.${h.changeKind}`)}</span> ·{' '}
              <time dateTime={h.createdAt}>{formatDateTime(h.createdAt, i18n.language)}</time>
              {h.publicNote && <p className="text-slate-700">{h.publicNote}</p>}
            </li>
          ))}
        </ol>
      </Card>

      {a.status === 'published' && <AssistantPanel articleSlug={a.slug} locationId={a.location.id} title={t('assistant.aboutArticle')} />}

      {user && a.status === 'published' && <ReportForm articleId={a.id} />}
    </article>
  );
}
