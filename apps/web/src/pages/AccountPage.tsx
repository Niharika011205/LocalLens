import { DisplayName, LANGUAGES, Password, type Language, type UserResponse } from '@locallens/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, errorCode, type ClientErrorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { setLanguage } from '../i18n';
import { Alert, Button, Card, PageTitle, TextField } from '../components/ui';
import { usePublicConfig } from '../components/Shorts';
import { TwoStepCard } from '../components/TwoStep';

function ChangePassword() {
  const { t } = useTranslation();
  const { setUser } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    setError(null);
    if (!Password.safeParse(form.newPassword).success) return setFieldError(t('validation.passwordLength'));
    setFieldError(undefined);
    setBusy(true);
    try {
      setUser((await api<UserResponse>('PUT', '/me/password', form)).user);
      setForm({ currentPassword: '', newPassword: '' });
      setDone(true);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="mb-5">
      <h3 className="mb-2 font-semibold">{t('account.changePassword')}</h3>
      {done && <Alert kind="success">{t('account.passwordChanged')}</Alert>}
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      <TextField
        label={t('account.currentPassword')}
        type="password"
        autoComplete="current-password"
        value={form.currentPassword}
        onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
      />
      <TextField
        label={t('account.newPassword')}
        type="password"
        autoComplete="new-password"
        value={form.newPassword}
        error={fieldError}
        hint={t('register.passwordHint')}
        onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
      />
      <Button type="submit" busy={busy}>
        {t('account.changePassword')}
      </Button>
    </form>
  );
}

function ReporterAccess() {
  const { t } = useTranslation();
  const config = usePublicConfig();
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientErrorCode | null>(null);
  if (!user) return null;

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setUser((await api<UserResponse>('POST', '/me/reporter-request')).user);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  const rr = user.reporterRequest;
  const isReporter = user.roles.includes('reporter');
  const instant = config.data?.reporterSelfSignup !== false;
  return (
    <Card>
      <div id="reporter" />
      <h2 className="mb-2 text-lg font-semibold">{t('account.reporterTitle')}</h2>
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      {isReporter ? (
        <p className="text-slate-700">
          {t('account.reporterApproved')}{' '}
          <Link to="/post" className="font-semibold text-rose-700 underline">
            + {t('nav.postNews')}
          </Link>
        </p>
      ) : rr.status === 'pending' ? (
        <Alert kind="info">{t('account.reporterPending')}</Alert>
      ) : (
        <>
          <p className="mb-3 text-slate-700">{rr.status === 'rejected' ? t('account.reporterRejected') : instant ? t('account.reporterNoneInstant') : t('account.reporterNone')}</p>
          {rr.status === 'rejected' && rr.note && <p className="mb-3 text-sm text-slate-600">{t('account.reporterNote', { note: rr.note })}</p>}
          <Button variant="secondary" busy={busy} onClick={request}>
            {rr.status === 'rejected' ? t('account.requestAgain') : instant ? t('account.becomeReporter') : t('account.requestReporter')}
          </Button>
        </>
      )}
    </Card>
  );
}

export function AccountPage() {
  const { hash } = useLocation();
  // Links like /account#reporter or #two-step open the page at that section.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);
  const { t, i18n } = useTranslation();
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [preferredLanguage, setPreferredLanguage] = useState<Language>(user?.preferredLanguage ?? 'te');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setError(null);
    if (!DisplayName.safeParse(displayName).success) return setFieldError(t('validation.displayName'));
    setFieldError(undefined);
    setBusy(true);
    try {
      const res = await api<UserResponse>('PATCH', '/me', { displayName, preferredLanguage });
      setUser(res.user);
      setLanguage(res.user.preferredLanguage);
      setSaved(true);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  const onSignOutEverywhere = async () => {
    setError(null);
    try {
      await api('POST', '/auth/logout-all');
      setUser(null);
      navigate('/login');
    } catch (err) {
      setError(errorCode(err));
    }
  };

  const memberSince = new Intl.DateTimeFormat(i18n.language === 'te' ? 'te-IN' : 'en-IN', {
    dateStyle: 'long',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(user.createdAt));

  return (
    <div className="space-y-5">
      <PageTitle>{t('account.title')}</PageTitle>
      {user.mustChangePassword && <Alert kind="info">{t('account.mustChange')}</Alert>}
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}

      <Card>
        <h2 className="mb-1 text-lg font-semibold">{t('account.profile')}</h2>
        <p className="mb-4 text-sm text-slate-600">
          {user.email} · {t('account.memberSince', { date: memberSince })}
        </p>
        {saved && <Alert kind="success">{t('common.saved')}</Alert>}
        <form onSubmit={onSave} noValidate>
          <TextField
            label={t('common.displayName')}
            value={displayName}
            error={fieldError}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <fieldset className="mb-5">
            <legend className="mb-1 font-medium text-slate-800">{t('account.languageLabel')}</legend>
            <div className="flex gap-4">
              {LANGUAGES.map((lang) => (
                <label key={lang} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="preferredLanguage"
                    className="size-4"
                    checked={preferredLanguage === lang}
                    onChange={() => setPreferredLanguage(lang)}
                  />
                  <span lang={lang}>{t(`languages.${lang}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-2 text-lg font-semibold">{t('account.roles')}</h2>
        <ul className="flex flex-wrap gap-2">
          {user.roles.map((r) => (
            <li key={r} className="rounded-full bg-rose-50 px-3 py-1 text-sm font-medium text-rose-900">
              {t(`roles.${r}`)}
            </li>
          ))}
        </ul>
      </Card>

      <ReporterAccess />

      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('account.security')}</h2>
        <ChangePassword />
        <p className="mb-3 text-slate-700">{t('account.signOutEverywhereHint')}</p>
        <Button variant="secondary" onClick={onSignOutEverywhere}>
          {t('account.signOutEverywhere')}
        </Button>
      </Card>

      <TwoStepCard />
    </div>
  );
}
