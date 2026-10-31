import type { MfaSetupResponse, MfaStatusResponse, RecoveryCodesResponse } from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorCode, type ClientErrorCode } from '../api/client';
import { ME_QUERY_KEY } from '../auth/AuthProvider';
import { Alert, Button, Card, StatusPill, TextField } from './ui';

/** The 6-digit code field: numeric keyboard on phones, and authenticator/SMS autofill hints. */
export function CodeField({ value, onChange, error, label }: { value: string; onChange: (v: string) => void; error?: string | undefined; label: string }) {
  return (
    <TextField
      label={label}
      value={value}
      error={error}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
    />
  );
}

function QrCanvas({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, text, { width: 192, margin: 1 });
  }, [text]);
  return <canvas ref={ref} width={192} height={192} className="rounded-lg border border-slate-200" aria-hidden="true" />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const download = () => {
    const blob = new Blob([`LocalLens recovery codes\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'locallens-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div>
      <Alert kind="info">{t('mfa.recoveryIntro')}</Alert>
      <ul className="my-3 grid grid-cols-2 gap-2 font-mono text-sm" aria-label={t('mfa.recoveryTitle')}>
        {codes.map((c) => (
          <li key={c} className="rounded bg-slate-100 px-2 py-1 text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={download}>
          {t('mfa.download')}
        </Button>
        <Button onClick={onDone}>{t('mfa.savedThem')}</Button>
      </div>
    </div>
  );
}

/** Account page card: turn two-step sign-in on, manage recovery codes, turn it off (when allowed). */
export function TwoStepCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['me', 'mfa'], queryFn: () => api<MfaStatusResponse>('GET', '/me/mfa') });
  const [stage, setStage] = useState<'idle' | 'password' | 'scan' | 'codes' | 'regenerate' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<{ code: ClientErrorCode; field?: 'currentPassword' | 'code' } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, field?: 'currentPassword' | 'code') => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError({ code: errorCode(err), ...(field ? { field } : {}) });
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['me', 'mfa'] });
    await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
  const reset = () => {
    setStage('idle');
    setPassword('');
    setCode('');
    setSetup(null);
    setError(null);
  };
  const fieldError = (field: 'currentPassword' | 'code') =>
    error?.field === field && error.code === 'VALIDATION_FAILED' ? t(field === 'code' ? 'mfa.badCode' : 'account.wrongPassword') : undefined;

  if (!status.data) return null;
  const s = status.data;

  return (
    <Card>
      <div id="two-step" className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('mfa.title')}</h2>
        <StatusPill tone={s.enabled ? 'emerald' : s.requiredForRoles ? 'amber' : 'slate'}>{s.enabled ? t('mfa.on') : t('mfa.off')}</StatusPill>
      </div>
      <p className="mb-3 text-sm text-slate-700">{t('mfa.intro')}</p>
      {s.requiredForRoles && !s.enabled && <Alert kind="info">{t('mfa.requiredForYou')}</Alert>}
      {error && !error.field && <Alert kind="error">{t(`errors.${error.code}`)}</Alert>}

      {stage === 'idle' && !s.enabled && (
        <Button onClick={() => setStage('password')}>{t('mfa.turnOn')}</Button>
      )}
      {stage === 'idle' && s.enabled && (
        <div className="space-y-2 text-sm">
          <p>{t('mfa.codesLeft', { count: s.recoveryCodesLeft })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setStage('regenerate')}>
              {t('mfa.newCodes')}
            </Button>
            {!(s.enforced && s.requiredForRoles) && (
              <Button variant="danger" onClick={() => setStage('disable')}>
                {t('mfa.turnOff')}
              </Button>
            )}
          </div>
        </div>
      )}

      {stage === 'password' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setSetup(await api<MfaSetupResponse>('POST', '/me/mfa/setup', { currentPassword: password }));
              setStage('scan');
            }, 'currentPassword');
          }}
        >
          <TextField label={t('account.currentPassword')} type="password" autoComplete="current-password" value={password} error={fieldError('currentPassword')} onChange={(e) => setPassword(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              {t('mfa.continue')}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t('mfa.cancel')}
            </Button>
          </div>
        </form>
      )}

      {stage === 'scan' && setup && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setCodes((await api<RecoveryCodesResponse>('POST', '/me/mfa/enable', { code })).recoveryCodes);
              setStage('codes');
              await refresh();
            }, 'code');
          }}
        >
          <ol className="mb-3 list-decimal space-y-2 pl-5 text-sm">
            <li>{t('mfa.step1')}</li>
            <li>
              {t('mfa.step2')}
              <div className="my-2 flex flex-wrap items-center gap-4">
                <QrCanvas text={setup.otpauthUrl} />
                <div className="text-xs">
                  <p className="mb-1">{t('mfa.orEnterKey')}</p>
                  <code className="block break-all rounded bg-slate-100 p-2 font-mono text-sm">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                  <a href={setup.otpauthUrl} className="mt-2 inline-block text-rose-800 underline">
                    {t('mfa.openApp')}
                  </a>
                </div>
              </div>
            </li>
            <li>{t('mfa.step3')}</li>
          </ol>
          <CodeField label={t('mfa.code')} value={code} onChange={setCode} error={fieldError('code')} />
          <div className="flex gap-2">
            <Button type="submit" busy={busy} disabled={code.length !== 6}>
              {t('mfa.confirm')}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t('mfa.cancel')}
            </Button>
          </div>
        </form>
      )}

      {stage === 'codes' && <RecoveryCodes codes={codes} onDone={reset} />}

      {stage === 'regenerate' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setCodes((await api<RecoveryCodesResponse>('POST', '/me/mfa/recovery-codes', { code })).recoveryCodes);
              setCode('');
              setStage('codes');
              await refresh();
            }, 'code');
          }}
        >
          <p className="mb-2 text-sm">{t('mfa.newCodesHelp')}</p>
          <CodeField label={t('mfa.code')} value={code} onChange={setCode} error={fieldError('code')} />
          <div className="flex gap-2">
            <Button type="submit" busy={busy} disabled={code.length !== 6}>
              {t('mfa.newCodes')}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t('mfa.cancel')}
            </Button>
          </div>
        </form>
      )}

      {stage === 'disable' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('POST', '/me/mfa/disable', { currentPassword: password, code });
              reset();
              await refresh();
            }, code.length === 6 && password ? 'code' : 'currentPassword');
          }}
        >
          <TextField label={t('account.currentPassword')} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <CodeField label={t('mfa.code')} value={code} onChange={setCode} error={error?.code === 'VALIDATION_FAILED' ? t('mfa.badCodeOrPassword') : undefined} />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" busy={busy} disabled={code.length !== 6 || !password}>
              {t('mfa.turnOff')}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t('mfa.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
