import {
  ROLES,
  type LocationSummary,
  type PublicUser,
  type ResetPasswordResponse,
  type Role,
  type UserListResponse,
  type UserResponse,
} from '@locallens/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { LocationPicker } from '../components/news';
import { locationLabel } from '../lib/format';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, errorCode, type ClientErrorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, PageTitle, TextField } from '../components/ui';

/** Editors can be limited to the places they cover; with no places they review submissions from everywhere. */
function EditorScopes({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ['admin', 'scopes', userId], queryFn: () => api<{ locations: LocationSummary[] }>('GET', `/admin/users/${userId}/scopes`) });
  const save = async (locations: LocationSummary[]) => {
    await api('PUT', `/admin/users/${userId}/scopes`, { locationIds: locations.map((l) => l.id) });
    void qc.invalidateQueries({ queryKey: ['admin', 'scopes', userId] });
  };
  const current = scopes.data?.locations ?? [];
  return (
    <div className="mb-3 rounded-lg bg-slate-50 p-3">
      <p className="text-sm font-medium">{t('admin.scopes')}</p>
      <p className="mb-2 text-xs text-slate-600">{current.length ? t('admin.scopesSome') : t('admin.scopesAll')}</p>
      <ul className="mb-2 flex flex-wrap gap-2">
        {current.map((l) => (
          <li key={l.id} className="flex items-center gap-1 rounded-full bg-white px-3 py-1 text-sm">
            {locationLabel(l, i18n.language)}
            <button type="button" aria-label={t('publishers.remove')} onClick={() => void save(current.filter((x) => x.id !== l.id))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <LocationPicker label={t('admin.addScope')} onPick={(l) => !current.some((c) => c.id === l.id) && void save([...current, l])} />
    </div>
  );
}

function UserRow({ user, isSelf, onChanged }: { user: PublicUser; isSelf: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const [reason, setReason] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [error, setError] = useState<{ code: ClientErrorCode; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown once, held only in this component's memory; never written to storage or logged.
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const dirty = roles.slice().sort().join() !== user.roles.slice().sort().join();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError({ code: errorCode(err), message: err instanceof ApiError ? err.message : '' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-slate-200 py-4 last:border-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold break-words">
            {user.displayName} {isSelf && <span className="text-sm font-normal text-slate-500">({t('admin.you')})</span>}
          </p>
          <p className="text-sm break-all text-slate-600">{user.email}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {user.reporterRequest.status === 'pending' && (
            <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900">{t('admin.pendingBadge')}</span>
          )}
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${user.status === 'active' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}
          >
            {t(`status.${user.status}`)}
          </span>
        </div>
      </div>
      {/* Server messages are shown for conflicts because they explain admin-specific rules. */}
      {error && <Alert kind="error">{error.code === 'CONFLICT' ? error.message : t(`errors.${error.code}`)}</Alert>}
      {user.reporterRequest.status === 'pending' && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            busy={busy}
            onClick={() => act(() => api('POST', `/admin/users/${user.id}/reporter-request`, { decision: 'approve' }))}
          >
            {t('admin.approve')}
          </Button>
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => act(() => api('POST', `/admin/users/${user.id}/reporter-request`, { decision: 'reject' }))}
          >
            {t('admin.reject')}
          </Button>
        </div>
      )}
      <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        <legend className="sr-only">{t('account.roles')}</legend>
        {ROLES.map((r) => (
          <label key={r} className="flex min-h-9 items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={roles.includes(r)}
              onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
            />
            {t(`roles.${r}`)}
          </label>
        ))}
      </fieldset>
      {user.roles.some((r) => r === 'editor' || r === 'senior_editor') && <EditorScopes userId={user.id} />}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!dirty}
          busy={busy}
          onClick={() => act(() => api<UserResponse>('PUT', `/admin/users/${user.id}/roles`, { roles }))}
        >
          {t('admin.saveRoles')}
        </Button>
        {!isSelf && user.status !== 'suspended' && !suspending && (
          <Button variant="danger" onClick={() => setSuspending(true)}>
            {t('admin.suspend')}
          </Button>
        )}
        {user.status === 'suspended' && (
          <Button variant="secondary" busy={busy} onClick={() => act(() => api('POST', `/admin/users/${user.id}/reactivate`))}>
            {t('admin.reactivate')}
          </Button>
        )}
        {!isSelf && (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              act(async () => {
                const res = await api<ResetPasswordResponse>('POST', `/admin/users/${user.id}/reset-password`);
                setTempPassword(res.temporaryPassword);
              })
            }
          >
            {t('admin.resetPassword')}
          </Button>
        )}
        {!isSelf && user.mfa.enabled && (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => {
              if (window.confirm(t('admin.resetMfaConfirm', { name: user.displayName }))) void act(() => api('POST', `/admin/users/${user.id}/mfa/reset`, {}));
            }}
          >
            {t('admin.resetMfa')}
          </Button>
        )}
      </div>
      {tempPassword && (
        <div className="mt-3">
          <Alert kind="success">
            <span className="font-semibold">
              {t('admin.tempPassword', { name: user.displayName, password: '' })}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-base select-all">{tempPassword}</code>
            </span>
            <span className="mt-1 block text-sm">{t('admin.tempPasswordHint')}</span>
          </Alert>
        </div>
      )}
      {suspending && (
        <form
          className="mt-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (reason.trim().length < 3) return setError({ code: 'VALIDATION_FAILED', message: '' });
            void act(() => api('POST', `/admin/users/${user.id}/suspend`, { reason })).then(() => setSuspending(false));
          }}
        >
          <TextField label={t('admin.suspendReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" variant="danger" busy={busy}>
            {t('admin.confirmSuspend')}
          </Button>
        </form>
      )}
    </li>
  );
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);

  const users = useInfiniteQuery({
    queryKey: ['admin', 'users', q, pendingOnly],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '20' });
      if (q) params.set('q', q);
      if (pendingOnly) params.set('reporterRequest', 'pending');
      if (pageParam) params.set('cursor', pageParam);
      return api<UserListResponse>('GET', `/admin/users?${params}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = users.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] });

  return (
    <div>
      <PageTitle>{t('admin.title')}</PageTitle>
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <div className="flex-1 [&>div]:mb-0">
          <TextField label={t('admin.search')} type="search" value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          {t('admin.searchButton')}
        </Button>
      </form>
      <div role="group" className="mb-4 flex flex-wrap gap-2">
        {[false, true].map((pending) => (
          <button
            key={String(pending)}
            type="button"
            aria-pressed={pendingOnly === pending}
            onClick={() => setPendingOnly(pending)}
            className={`min-h-9 rounded-full border px-3 text-sm font-medium ${pendingOnly === pending ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white text-slate-800'}`}
          >
            {pending ? t('admin.filterPending') : t('admin.filterAll')}
          </button>
        ))}
      </div>
      <Card>
        {users.isPending && <p className="text-slate-500">{t('common.loading')}</p>}
        {users.isError && <Alert kind="error">{t(`errors.${errorCode(users.error)}`)}</Alert>}
        {users.isSuccess && items.length === 0 && <p className="text-slate-600">{t('admin.empty')}</p>}
        <ul>
          {items.map((u) => (
            // Keyed by roles too, so a row resets its local edits after a save refreshes the data.
            <UserRow
              key={`${u.id}:${u.roles.join()}:${u.status}:${u.reporterRequest.status}`}
              user={u}
              isSelf={u.id === me?.id}
              onChanged={refresh}
            />
          ))}
        </ul>
        {users.hasNextPage && (
          <Button variant="secondary" busy={users.isFetchingNextPage} onClick={() => void users.fetchNextPage()}>
            {t('admin.loadMore')}
          </Button>
        )}
      </Card>
    </div>
  );
}
