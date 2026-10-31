import { DisplayName, Email, LANGUAGES, Password, type Language, type LoginResponse, type PublicUser, type UserResponse } from '@locallens/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, errorCode, type ClientErrorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { usePublicConfig } from '../components/Shorts';
import { Icon } from '../components/icons';
import { CodeField } from '../components/TwoStep';
import { Alert, Button, Card, PageTitle, TextField } from '../components/ui';
import { setLanguage } from '../i18n';

type FieldErrors = Partial<Record<'email' | 'password' | 'displayName', string>>;

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** After sign-in or sign-up: apply the user's language and go where they were heading (or to the account page to
 * replace a temporary password). */
function useSignedIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? '/news';
  return (user: PublicUser) => {
    setLanguage(user.preferredLanguage);
    setUser(user);
    navigate(user.mustChangePassword ? '/account' : from, { replace: true });
  };
}

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-2">
      <Card>
        <PageTitle>{title}</PageTitle>
        {subtitle && <p className="-mt-2 mb-5 text-stone-600">{subtitle}</p>}
        {children}
      </Card>
    </div>
  );
}

/** A big tappable choice (radio underneath, so keyboards and screen readers work as usual). */
function ChoiceCard({ checked, onSelect, title, body, icon }: { checked: boolean; onSelect: () => void; title: string; body: string; icon: 'news' | 'camera' }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-2xl border-2 p-4 transition ${checked ? 'border-rose-600 bg-rose-50' : 'border-stone-200 bg-white hover:border-stone-300'}`}>
      <input type="radio" name="role" className="sr-only" checked={checked} onChange={onSelect} />
      <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${checked ? 'bg-rose-600 text-white' : 'bg-stone-100 text-stone-700'}`}>
        <Icon name={icon} />
      </span>
      <span className="min-w-0">
        <span className="block font-bold text-stone-900">{title}</span>
        <span className="block text-sm text-stone-600">{body}</span>
      </span>
      {checked && (
        <span className="ml-auto text-rose-600">
          <Icon name="check" className="size-5" />
        </span>
      )}
    </label>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const signedIn = useSignedIn();
  const { busy, error, run } = useAction();
  const [fields, setFields] = useState<FieldErrors>({});
  const [form, setForm] = useState({ email: '', password: '' });
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [expired, setExpired] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!Email.safeParse(form.email).success) errs.email = t('validation.email');
    if (!form.password) errs.password = t('validation.passwordRequired');
    setFields(errs);
    if (Object.keys(errs).length) return;
    setExpired(false);
    void run(async () => {
      const res = await api<LoginResponse>('POST', '/auth/login', form);
      if ('user' in res) return signedIn(res.user);
      setStep('code');
    });
  };

  const onCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        signedIn((await api<UserResponse>('POST', '/auth/mfa', { code: code.trim() })).user);
      } catch (err) {
        if (errorCode(err) !== 'UNAUTHENTICATED') throw err;
        // The 5-minute, 5-attempt window is over: start again with the password (not "wrong password").
        setStep('password');
        setCode('');
        setExpired(true);
      }
    });
  };

  if (step === 'code') {
    return (
      <AuthCard title={t('login.codeTitle')}>
        {error && <Alert kind="error">{error === 'VALIDATION_FAILED' ? t('mfa.badCode') : t(`errors.${error}`)}</Alert>}
        <p className="mb-3 text-slate-700">{useRecovery ? t('login.recoveryHelp') : t('login.codeHelp')}</p>
        <form onSubmit={onCode} noValidate>
          {useRecovery ? (
            <TextField label={t('login.recoveryCode')} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          ) : (
            <CodeField label={t('mfa.code')} value={code} onChange={setCode} />
          )}
          <Button type="submit" busy={busy} className="w-full" disabled={useRecovery ? code.trim().length < 8 : code.length !== 6}>
            {t('login.submit')}
          </Button>
        </form>
        <button
          type="button"
          className="mt-4 text-sm text-rose-800 underline"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setCode('');
          }}
        >
          {useRecovery ? t('login.useApp') : t('login.useRecovery')}
        </button>
        <p className="mt-2 text-sm text-slate-600">{t('login.lostPhone')}</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('login.title')} subtitle={t('login.subtitle')}>
      {expired && !error && <Alert kind="info">{t('login.codeExpired')}</Alert>}
      {error && <Alert kind="error">{error === 'UNAUTHENTICATED' ? t('login.badCredentials') : t(`errors.${error}`)}</Alert>}
      <form onSubmit={onSubmit} noValidate>
        <TextField
          label={t('common.email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={form.email}
          error={fields.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <TextField
          label={t('common.password')}
          type="password"
          autoComplete="current-password"
          value={form.password}
          error={fields.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Button type="submit" busy={busy} className="w-full">
          {t('login.submit')}
        </Button>
      </form>
      <p className="mt-4 text-sm text-slate-600">{t('login.forgot')}</p>
      <p className="mt-2 text-sm text-slate-600">
        {t('login.noAccount')}{' '}
        <Link to="/register" className="font-medium text-rose-800 underline">
          {t('nav.register')}
        </Link>
      </p>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { t, i18n } = useTranslation();
  const config = usePublicConfig();
  const [params] = useSearchParams();
  const signedIn = useSignedIn();
  const { busy, error, run } = useAction();
  const [fields, setFields] = useState<FieldErrors>({});
  const [form, setForm] = useState({
    displayName: '',
    email: '',
    password: '',
    preferredLanguage: (i18n.language === 'en' ? 'en' : 'te') as Language,
    requestReporter: params.get('as') === 'reporter',
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!DisplayName.safeParse(form.displayName).success) errs.displayName = t('validation.displayName');
    if (!Email.safeParse(form.email).success) errs.email = t('validation.email');
    if (!Password.safeParse(form.password).success) errs.password = t('validation.passwordLength');
    setFields(errs);
    if (Object.keys(errs).length) return;
    void run(async () => signedIn((await api<UserResponse>('POST', '/auth/register', form)).user));
  };

  return (
    <AuthCard title={t('register.title')} subtitle={t('register.subtitle')}>
      {error && (
        <Alert kind="error">
          {t(`errors.${error}`)}{' '}
          {error === 'EMAIL_TAKEN' && (
            <Link to="/login" className="font-semibold underline">
              {t('nav.signIn')}
            </Link>
          )}
        </Alert>
      )}
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="mb-5 space-y-2">
          <legend className="mb-2 font-semibold text-stone-800">{t('register.roleLabel')}</legend>
          <ChoiceCard checked={!form.requestReporter} onSelect={() => setForm({ ...form, requestReporter: false })} icon="news" title={t('register.roleReader')} body={t('register.roleReaderBody')} />
          <ChoiceCard
            checked={form.requestReporter}
            onSelect={() => setForm({ ...form, requestReporter: true })}
            icon="camera"
            title={t('register.roleReporter')}
            body={config.data?.reporterSelfSignup === false ? t('register.roleReporterHint') : t('register.roleReporterNow')}
          />
        </fieldset>
        <TextField
          label={t('common.displayName')}
          autoComplete="name"
          value={form.displayName}
          error={fields.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
        <TextField
          label={t('common.email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={form.email}
          error={fields.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <TextField
          label={t('common.password')}
          type="password"
          autoComplete="new-password"
          value={form.password}
          error={fields.password}
          hint={t('register.passwordHint')}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <fieldset className="mb-4">
          <legend className="mb-1 font-medium text-slate-800">{t('register.languageLabel')}</legend>
          <div className="flex gap-4">
            {LANGUAGES.map((lang) => (
              <label key={lang} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="preferredLanguage"
                  className="size-4"
                  checked={form.preferredLanguage === lang}
                  onChange={() => setForm({ ...form, preferredLanguage: lang })}
                />
                <span lang={lang}>{t(`languages.${lang}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" busy={busy} className="w-full">
          {t('register.submit')}
        </Button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        {t('register.haveAccount')}{' '}
        <Link to="/login" className="font-medium text-rose-800 underline">
          {t('nav.signIn')}
        </Link>
      </p>
    </AuthCard>
  );
}
