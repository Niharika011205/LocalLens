import type { AiAssessment, VerificationResponse } from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorCode } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Alert, Button, Card, StatusPill } from './ui';

const TONE: Record<AiAssessment, 'emerald' | 'red' | 'amber' | 'slate' | 'sky'> = {
  supported: 'emerald',
  contradicted: 'red',
  mixed: 'amber',
  insufficient_evidence: 'slate',
  not_assessed: 'sky',
};

/**
 * Shows the AI analysis as evidence an editor can inspect — claims, sources, verbatim excerpts, what is missing — and
 * deliberately no confidence percentage. It is advisory: nothing here can approve or publish.
 */
export function VerificationPanel({ submissionId }: { submissionId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['editorial', 'verification', submissionId],
    queryFn: () => api<VerificationResponse>('GET', `/editorial/submissions/${submissionId}/verification`),
    refetchInterval: (query) => (query.state.data?.report?.status === 'pending' ? 5000 : false),
  });

  const retry = async () => {
    setError(null);
    try {
      await api('POST', `/editorial/submissions/${submissionId}/verification/retry`, {});
      await qc.invalidateQueries({ queryKey: ['editorial', 'verification', submissionId] });
    } catch (err) {
      setError(t(`errors.${errorCode(err)}`));
    }
  };

  const report = q.data?.report;
  if (!report) return null;
  const r = report.result;
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">{t('verification.title')}</h2>
      <p className="mb-3 text-sm text-slate-600">{t('verification.advisory')}</p>
      {error && <Alert kind="error">{error}</Alert>}

      {report.status === 'pending' && <Alert kind="info">{t('verification.pending')}</Alert>}
      {(report.status === 'failed' || report.status === 'unavailable') && (
        <Alert kind="error">
          {t(`verification.${report.status}`)} {report.error}
          <div className="mt-2">
            <Button variant="secondary" onClick={() => void retry()}>
              {t('verification.retry')}
            </Button>
          </div>
        </Alert>
      )}

      {r && (
        <div className="space-y-4">
          <p className="text-sm">
            <strong>{t('verification.recommendation')}:</strong> {t(`verification.rec_${r.recommendation}`)}
          </p>
          {!r.language_matches_declared && <Alert kind="info">{t('verification.languageMismatch', { lang: r.detected_language })}</Alert>}

          <ol className="space-y-3">
            {r.claims.map((c) => {
              const ev = r.evidence.filter((e) => e.claim_id === c.id);
              return (
                <li key={c.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <StatusPill tone={TONE[c.assessment]}>{t(`verification.assessment_${c.assessment}`)}</StatusPill>
                    <span className="text-xs text-slate-500">{t(`verification.kind_${c.kind}`)}</span>
                  </div>
                  <p className="font-medium">{c.text}</p>
                  {c.rationale && <p className="mt-1 text-sm text-slate-700">{c.rationale}</p>}
                  {ev.map((e) => (
                    <blockquote key={e.id} className={`mt-2 border-l-4 pl-3 text-sm ${e.stance === 'supports' ? 'border-emerald-400' : 'border-red-400'}`}>
                      “{e.excerpt}”
                      <footer className="mt-1 text-xs text-slate-600">
                        {t(`verification.stance_${e.stance}`)} ·{' '}
                        <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
                          {e.url}
                        </a>{' '}
                        · {t(`verification.source_${e.source_type}`)}
                        {e.published_at && ` · ${t('verification.published')} ${e.published_at}`} · {t('verification.retrieved')}{' '}
                        {formatDateTime(e.retrieved_at, i18n.language)}
                      </footer>
                    </blockquote>
                  ))}
                  {c.missing_evidence.length > 0 && (
                    <p className="mt-2 text-sm text-slate-700">
                      <strong>{t('verification.missing')}:</strong> {c.missing_evidence.join('; ')}
                    </p>
                  )}
                  {c.uncertainty && (
                    <p className="mt-1 text-sm text-slate-700">
                      <strong>{t('verification.uncertainty')}:</strong> {c.uncertainty}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>

          {r.sources.length > 0 && (
            <div>
              <h3 className="font-semibold">{t('verification.sources')}</h3>
              <ul className="text-sm">
                {r.sources.map((s) => (
                  <li key={s.url} className="break-all">
                    <StatusPill tone={s.status === 'fetched' ? 'emerald' : 'slate'}>{t(`verification.fetch_${s.status}`)}</StatusPill> {s.url}{' '}
                    <span className="text-slate-600">· {s.reliability_rationale}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.meta.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-slate-600">
              {r.meta.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">
            {r.meta.provider} / {r.meta.model} · {Object.values(r.meta.prompt_versions).join(', ')} · {r.meta.pipeline_version} · v{report.submissionVersion}
          </p>
        </div>
      )}
    </Card>
  );
}
