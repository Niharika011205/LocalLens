import {
  LANGUAGES,
  PUBLISHER_STATUSES,
  type AnnouncementResponse,
  type Language,
  type LocationSummary,
  type PublisherOrg,
  type UserListResponse,
} from '@locallens/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, ApiError, errorCode, fieldErrors, type ClientErrorCode } from '../api/client';
import { useCategories } from '../api/hooks';
import { LocationPicker } from '../components/news';
import { Alert, Button, Card, PageTitle, Select, StatusPill, TextArea, TextField } from '../components/ui';
import { localName, locationLabel } from '../lib/format';

type OrgForm = { id?: string; name: string; status: PublisherOrg['status']; jurisdictions: LocationSummary[]; categoryIds: string[]; domains: string };
const emptyOrg: OrgForm = { name: '', status: 'onboarding', jurisdictions: [], categoryIds: [], domains: '' };

function OrgEditor({ initial, onDone }: { initial: OrgForm; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const categories = useCategories();
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: f.name,
        status: f.status,
        jurisdictionIds: f.jurisdictions.map((j) => j.id),
        allowedCategoryIds: f.categoryIds,
        officialDomains: f.domains.split(/[\s,]+/).filter(Boolean),
      };
      await api(f.id ? 'PUT' : 'POST', f.id ? `/admin/publishers/${f.id}` : '/admin/publishers', body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.details?.map((d) => `${d.path}: ${d.message}`).join('; ') || err.message : t('errors.INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate>
      {error && <Alert kind="error">{error}</Alert>}
      <TextField label={t('publishers.name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <Select label={t('publishers.status')} value={f.status} options={PUBLISHER_STATUSES.map((s) => ({ value: s, label: t(`publishers.status_${s}`) }))} onChange={(v) => setF({ ...f, status: v })} />
      <div className="mb-2">
        <p className="mb-1 font-medium text-slate-800">{t('publishers.jurisdictions')}</p>
        <ul className="mb-2 flex flex-wrap gap-2">
          {f.jurisdictions.map((j) => (
            <li key={j.id} className="flex items-center gap-1 rounded-full bg-rose-50 px-3 py-1 text-sm">
              {locationLabel(j, i18n.language)}
              <button type="button" aria-label={t('publishers.remove')} onClick={() => setF({ ...f, jurisdictions: f.jurisdictions.filter((x) => x.id !== j.id) })}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
      <LocationPicker label={t('publishers.addJurisdiction')} onPick={(l) => !f.jurisdictions.some((j) => j.id === l.id) && setF({ ...f, jurisdictions: [...f.jurisdictions, l] })} />
      <fieldset className="mb-4">
        <legend className="mb-1 font-medium text-slate-800">{t('publishers.categories')}</legend>
        <p className="mb-2 text-sm text-slate-600">{t('publishers.categoriesHint')}</p>
        {categories.data?.items.map((c) => (
          <label key={c.id} className="flex min-h-9 items-center gap-2">
            <input
              type="checkbox"
              className="size-4"
              checked={f.categoryIds.includes(c.id)}
              onChange={(e) => setF({ ...f, categoryIds: e.target.checked ? [...f.categoryIds, c.id] : f.categoryIds.filter((x) => x !== c.id) })}
            />
            {localName(c.name, i18n.language)}
          </label>
        ))}
      </fieldset>
      <TextArea label={t('publishers.domains')} rows={2} value={f.domains} hint={t('publishers.domainsHint')} onChange={(v) => setF({ ...f, domains: v })} />
      <Button type="submit" busy={busy}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function AssignMember({ org }: { org: PublisherOrg }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const assign = async () => {
    setMsg(null);
    try {
      const found = await api<UserListResponse>('GET', `/admin/users?q=${encodeURIComponent(email.trim())}&limit=2`);
      const user = found.items.find((u) => u.email === email.trim().toLowerCase());
      if (!user) return setMsg({ kind: 'error', text: t('publishers.userNotFound') });
      await api('PUT', `/admin/users/${user.id}/publisher`, { orgId: org.id });
      if (!user.roles.includes('publisher')) await api('PUT', `/admin/users/${user.id}/roles`, { roles: [...user.roles, 'publisher'] });
      setEmail('');
      setMsg({ kind: 'success', text: t('publishers.assigned', { email: user.email }) });
      void qc.invalidateQueries({ queryKey: ['admin', 'publishers'] });
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : t('errors.INTERNAL') });
    }
  };
  return (
    <div className="mt-3">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="flex items-end gap-2 [&>div]:mb-0 [&>div]:flex-1">
        <TextField label={t('publishers.addMember')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button variant="secondary" onClick={() => void assign()}>
          {t('publishers.assign')}
        </Button>
      </div>
    </div>
  );
}

export function AdminPublishersPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'publishers'], queryFn: () => api<{ items: PublisherOrg[] }>('GET', '/admin/publishers') });
  const [editing, setEditing] = useState<OrgForm | null>(null);
  const done = () => {
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ['admin', 'publishers'] });
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t('publishers.title')}</PageTitle>
        {!editing && <Button onClick={() => setEditing(emptyOrg)}>{t('publishers.new')}</Button>}
      </div>
      <p className="text-slate-700">{t('publishers.intro')}</p>
      {editing && (
        <Card>
          <OrgEditor initial={editing} onDone={done} />
        </Card>
      )}
      {list.data?.items.map((o) => (
        <Card key={o.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{o.name}</h2>
            <StatusPill tone={o.status === 'active' ? 'emerald' : o.status === 'suspended' ? 'red' : 'amber'}>{t(`publishers.status_${o.status}`)}</StatusPill>
          </div>
          <p className="mt-1 text-sm text-slate-700">
            {t('publishers.jurisdictions')}: {o.jurisdictions.map((j) => locationLabel(j, i18n.language)).join('; ')}
          </p>
          <p className="text-sm text-slate-700">
            {t('publishers.categories')}: {o.allowedCategories.map((c) => localName(c.name, i18n.language)).join(', ')}
          </p>
          <p className="text-sm text-slate-700">
            {t('publishers.domains')}: {o.officialDomains.join(', ')} · {t('publishers.members', { count: o.memberCount })}
          </p>
          <div className="mt-2">
            <Button
              variant="secondary"
              onClick={() =>
                setEditing({ id: o.id, name: o.name, status: o.status, jurisdictions: o.jurisdictions, categoryIds: o.allowedCategories.map((c) => c.id), domains: o.officialDomains.join(', ') })
              }
            >
              {t('publishers.edit')}
            </Button>
          </div>
          <AssignMember org={o} />
        </Card>
      ))}
      {list.isSuccess && !list.data.items.length && !editing && <p className="text-slate-600">{t('publishers.none')}</p>}
    </div>
  );
}

export function PublisherAnnouncePage() {
  const { t, i18n } = useTranslation();
  const org = useQuery({ queryKey: ['publisher', 'me'], queryFn: () => api<{ org: PublisherOrg | null }>('GET', '/publisher/me') });
  const [f, setF] = useState({ headline: '', summary: '', body: '', language: (i18n.language === 'en' ? 'en' : 'te') as Language, categoryId: '', originalSourceUrl: '', deadline: '' });
  const [location, setLocation] = useState<LocationSummary | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [result, setResult] = useState<AnnouncementResponse | null>(null);
  const [busy, setBusy] = useState(false);

  if (org.isPending) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (!org.data?.org) return <Alert kind="info">{t('publisherPage.notLinked')}</Alert>;
  const o = org.data.org;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<AnnouncementResponse>('POST', '/publisher/announcements', {
        ...f,
        locationId: location?.id ?? '',
        deadline: f.deadline || undefined,
      });
      setResult(res);
      setErrors({});
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageTitle>{t('publisherPage.title')}</PageTitle>
      <p className="text-slate-700">{t('publisherPage.intro', { org: o.name })}</p>
      <Alert kind="info">{t('publisherPage.rules', { domains: o.officialDomains.join(', ') })}</Alert>
      {result?.outcome === 'published' && (
        <Alert kind="success">
          {t('publisherPage.published')}{' '}
          <Link to={`/articles/${result.article.slug}`} className="font-semibold underline">
            {result.article.headline}
          </Link>
        </Alert>
      )}
      {result?.outcome === 'sent_for_review' && (
        <Alert kind="info">
          {t('publisherPage.sentForReview')} {result.reasons.map((r) => t(`publisherReason.${r}`, { defaultValue: r })).join('; ')}{' '}
          <Link to={`/reporter/submissions/${result.submissionId}`} className="font-semibold underline">
            {t('publisherPage.track')}
          </Link>
        </Alert>
      )}
      {error && <Alert kind="error">{t(`errors.${error}`)}</Alert>}
      <Card>
        <form onSubmit={submit} noValidate>
          <Select label={t('editor.language')} value={f.language} options={LANGUAGES.map((l) => ({ value: l, label: t(`languages.${l}`) }))} onChange={(v) => setF({ ...f, language: v })} />
          <TextField label={t('editor.headline')} lang={f.language} value={f.headline} error={errors.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} />
          <TextArea label={t('editor.summary')} lang={f.language} rows={2} value={f.summary} error={errors.summary} onChange={(v) => setF({ ...f, summary: v })} />
          <TextArea label={t('editor.body')} lang={f.language} rows={8} value={f.body} error={errors.body} onChange={(v) => setF({ ...f, body: v })} />
          {location ? (
            <p className="mb-4">
              {t('editor.location')}: <strong>{locationLabel(location, i18n.language)}</strong>{' '}
              <button type="button" className="text-sm text-rose-800 underline" onClick={() => setLocation(null)}>
                {t('editor.change')}
              </button>
            </p>
          ) : (
            <LocationPicker label={t('editor.location')} onPick={setLocation} />
          )}
          <Select
            label={t('editor.category')}
            value={f.categoryId}
            error={errors.categoryId}
            options={[{ value: '', label: '—' }, ...o.allowedCategories.map((c) => ({ value: c.id, label: localName(c.name, i18n.language) }))]}
            onChange={(v) => setF({ ...f, categoryId: v })}
          />
          <TextField label={t('publisherPage.sourceUrl')} type="url" value={f.originalSourceUrl} error={errors.originalSourceUrl} onChange={(e) => setF({ ...f, originalSourceUrl: e.target.value })} />
          <TextField label={t('publisherPage.deadline')} type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
          <Button type="submit" busy={busy}>
            {t('publisherPage.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
