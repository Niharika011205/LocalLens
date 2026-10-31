import { TRACK_RULES, type Submission, type TrackRecord } from '@locallens/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusPill, TextArea } from './ui';
import { formatDateTime } from '../lib/format';

const TIER_TONE = { new: 'slate', standard: 'sky', trusted: 'emerald', needs_support: 'amber' } as const;

/** The whole record, with the rules that produce it: nothing about it is hidden from the reporter. */
export function TrackRecordView({ record, own }: { record: TrackRecord; own: boolean }) {
  const { t } = useTranslation();
  const reasons = Object.entries(record.rejectedByReason);
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <StatusPill tone={TIER_TONE[record.tier]}>{t(`track.tier_${record.tier}`)}</StatusPill>
        <span className="text-slate-600">{t('track.window', { days: record.windowDays })}</span>
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        <li>{t('track.published', { count: record.published })}</li>
        <li>{t('track.rejected', { count: record.rejected })}</li>
        <li>{t('track.returned', { count: record.returnedForChanges })}</li>
        <li>{t('track.corrections', { count: record.corrections })}</li>
        <li>{t('track.retractions', { count: record.retractions })}</li>
        <li>{t('track.overturned', { count: record.appealsOverturned })}</li>
      </ul>
      {reasons.length > 0 && (
        <p className="text-slate-700">
          {t('track.reasons')} {reasons.map(([r, n]) => `${t(`rejection.${r}`, { defaultValue: r })} (${n})`).join(', ')}
        </p>
      )}
      {record.queueHeadStartHours > 0 && <p className="text-emerald-800">{t('track.headStart', { hours: record.queueHeadStartHours })}</p>}
      {own && (
        <details className="text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-800">{t('track.howTitle')}</summary>
          <p className="mt-1">
            {t('track.how', {
              min: TRACK_RULES.minDecisions,
              trustedMin: TRACK_RULES.trustedMinDecisions,
              share: Math.round(TRACK_RULES.trustedMinPublishedShare * 100),
              hours: TRACK_RULES.trustedHeadStartHours,
            })}
          </p>
        </details>
      )}
    </div>
  );
}

/** For the reporter, on a rejected report: appeal it (once, within the window) or see how the appeal went. */
export function AppealBox({ sub, onAppeal }: { sub: Submission; onAppeal: (note: string) => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (sub.appeal) {
    return (
      <Alert kind={sub.appeal.status === 'overturned' ? 'success' : 'info'}>
        <strong>{t(`appeals.status_${sub.appeal.status}`)}</strong>
        {sub.appeal.decisionNote && <span className="block whitespace-pre-line">{sub.appeal.decisionNote}</span>}
      </Alert>
    );
  }
  if (!sub.appealUntil) return null;
  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t('appeals.title')}</h2>
      <p className="mb-3 text-sm text-slate-600">{t('appeals.intro', { until: formatDateTime(sub.appealUntil, i18n.language) })}</p>
      <TextArea label={t('appeals.why')} rows={3} value={note} onChange={setNote} hint={t('appeals.whyHint')} />
      <Button
        variant="secondary"
        busy={busy}
        disabled={note.trim().length < 20}
        onClick={async () => {
          setBusy(true);
          try {
            await onAppeal(note.trim());
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('appeals.send')}
      </Button>
    </div>
  );
}
