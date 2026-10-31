import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '@locallens/contracts';
import { Alert } from '../components/ui';
import { useAuth } from './AuthProvider';

// UI guards improve the experience only; the API enforces every permission independently.

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  if (loading) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { hasRole } = useAuth();
  const { t } = useTranslation();
  return (
    <RequireAuth>
      {hasRole(...roles) ? children : <Alert kind="error">{t('errors.FORBIDDEN')}</Alert>}
    </RequireAuth>
  );
}
