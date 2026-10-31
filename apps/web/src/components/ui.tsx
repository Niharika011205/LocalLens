import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">{children}</section>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-2xl font-bold leading-snug text-slate-900">{children}</h1>;
}

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger'; busy?: boolean }) {
  const styles = {
    primary: 'bg-rose-700 text-white hover:bg-rose-800 focus-visible:outline-rose-700',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:outline-slate-500',
    danger: 'bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700',
  }[variant];
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function TextField({
  label,
  error,
  hint,
  type = 'text',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: string }) {
  const id = useId();
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password';
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        type={isPassword && reveal ? 'text' : type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
        className={`block min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-base text-slate-900 focus:outline-2 focus:outline-offset-1 focus:outline-rose-700 ${error ? 'border-red-600' : 'border-slate-300'} ${rest.className ?? ''}`}
      />
      {isPassword && (
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} className="size-4" />
          {t('common.showPassword')}
        </label>
      )}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 4,
  error,
  hint,
  lang,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  error?: string | undefined;
  hint?: string;
  lang?: string;
}) {
  const id = useId();
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block font-medium text-slate-800">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        lang={lang}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`block w-full rounded-lg border bg-white px-3 py-2 text-base focus:outline-2 focus:outline-rose-700 ${error ? 'border-red-600' : 'border-slate-300'}`}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error && <span className="mt-1 block text-sm font-medium text-red-700">{error}</span>}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  error?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-invalid={error ? true : undefined}
        className={`block min-h-11 w-full rounded-lg border bg-white px-3 text-base focus:outline-2 focus:outline-rose-700 ${error ? 'border-red-600' : 'border-slate-300'}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="mt-1 block text-sm font-medium text-red-700">{error}</span>}
    </div>
  );
}

export function StatusPill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' | 'red' | 'emerald' | 'sky' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-800',
    amber: 'bg-amber-50 text-amber-900',
    red: 'bg-red-50 text-red-800',
    emerald: 'bg-emerald-50 text-emerald-900',
    sky: 'bg-sky-50 text-sky-900',
  };
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-lg border px-4 py-3 ${styles}`}>
      {children}
    </div>
  );
}
