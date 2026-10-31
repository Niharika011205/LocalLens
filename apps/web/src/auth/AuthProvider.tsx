import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { PublicUser, Role, SessionResponse } from '@locallens/contracts';
import { api } from '../api/client';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  setUser: (user: PublicUser | null) => void;
  signOut: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);
export const ME_QUERY_KEY = ['auth', 'me'] as const;

/** Who is signed in (null = nobody). Uses /auth/session, which answers 200 either way, so visitors see no errors. */
async function fetchMe(): Promise<PublicUser | null> {
  return (await api<SessionResponse>('GET', '/auth/session')).user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 60_000, retry: false });

  const setUser = useCallback((user: PublicUser | null) => qc.setQueryData(ME_QUERY_KEY, user), [qc]);

  const signOut = useCallback(async () => {
    // Sign out on this screen even if the network call fails: the user asked to leave.
    await api('POST', '/auth/logout').catch(() => undefined);
    // Set "nobody" on the live sign-in query first. (qc.clear() would detach the screen from it, so the old user stayed
    // visible.) Then drop everything cached for the old account: feeds, saved items, alerts…
    qc.setQueryData(ME_QUERY_KEY, null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const user = me.data ?? null;
    return {
      user,
      loading: me.isPending,
      setUser,
      signOut,
      hasRole: (...roles) => !!user && user.roles.some((r) => roles.includes(r)),
    };
  }, [me.data, me.isPending, setUser, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
