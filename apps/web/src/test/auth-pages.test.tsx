import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { LoginPage, RegisterPage } from '../pages/auth';

type Reply = { status: number; body?: unknown };

/** Routes fetch calls by "METHOD path" to canned replies and records request bodies. */
function mockApi(routes: Record<string, Reply>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = routes[key] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nf' } } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/account" element={<p>account-page</p>} />
            <Route path="/" element={<p>home-page</p>} />
            <Route path="/news" element={<p>news-page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const anonymous: Reply = { status: 200, body: { user: null } };
const user = {
  id: 'a'.repeat(24),
  email: 'ravi@example.in',
  displayName: 'Ravi',
  preferredLanguage: 'en',
  roles: ['reader'],
  status: 'active',
  reporterRequest: { status: 'none', requestedAt: null, decidedAt: null, note: null },
  mustChangePassword: false,
  mfa: { enabled: false, requiredForRoles: false },
  createdAt: '2026-10-10T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('validates before calling the API', async () => {
    const calls = mockApi({ 'GET /auth/session': anonymous });
    renderAt('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'POST /auth/login')).toHaveLength(0);
  });

  it('shows a generic message for wrong credentials', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'POST /auth/login': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Incorrect email or password' } } },
    });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
  });

  it('signs in and goes home; a temporary password goes to the account page instead', async () => {
    mockApi({ 'GET /auth/session': anonymous, 'POST /auth/login': { status: 200, body: { user: { ...user, mustChangePassword: true } } } });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'temporary1234');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('account-page')).toBeInTheDocument();
  });

  it('asks for the authenticator code when two-step sign-in is on, and offers a recovery code', async () => {
    const calls = mockApi({
      'GET /auth/session': anonymous,
      'POST /auth/login': { status: 200, body: { mfaRequired: true } },
      'POST /auth/mfa': { status: 200, body: { user } },
    });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your code')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('6-digit code'), '12a34 56'); // non-digits are ignored
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    expect(screen.getByText('Use a recovery code instead')).toBeInTheDocument();
    await userEvent.click(submit);
    expect(await screen.findByText('news-page')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /auth/mfa')?.body).toEqual({ code: '123456' });
  });

  it('goes back to the password step when the code window has expired', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'POST /auth/login': { status: 200, body: { mfaRequired: true } },
      'POST /auth/mfa': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'expired' } } },
    });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Your sign-in expired. Enter your email and password again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});

describe('RegisterPage', () => {
  it('rejects a short password client-side, then sends a reporter request with the account', async () => {
    const calls = mockApi({ 'GET /auth/session': anonymous, 'POST /auth/register': { status: 201, body: { user } } });
    renderAt('/register');
    await userEvent.type(screen.getByLabelText('Your name'), 'Ravi');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Password must be 8–128 characters.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Password'), ' but long enough');
    await userEvent.click(screen.getByLabelText(/I am a reporter/));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('news-page')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /auth/register')?.body).toEqual({
        displayName: 'Ravi',
        email: 'ravi@example.in',
        password: 'short but long enough',
        preferredLanguage: 'en',
        requestReporter: true,
      }),
    );
  });

  it('explains when the email is already registered', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'POST /auth/register': { status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'exists' } } },
    });
    renderAt('/register');
    await userEvent.type(screen.getByLabelText('Your name'), 'Ravi');
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.in');
    await userEvent.type(screen.getByLabelText('Password'), 'long enough pass');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/An account with this email already exists/)).toBeInTheDocument();
  });
});
