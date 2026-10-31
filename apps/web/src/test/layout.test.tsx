import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { Layout } from '../components/Layout';

const base = {
  id: 'a'.repeat(24),
  email: 'ravi@example.in',
  displayName: 'Ravi',
  preferredLanguage: 'en',
  status: 'active',
  reporterRequest: { status: 'none', requestedAt: null, decidedAt: null, note: null },
  mustChangePassword: false,
  mfa: { enabled: false, requiredForRoles: false },
  createdAt: '2026-10-10T00:00:00.000Z',
};

function renderAs(me: { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/auth/session')) return new Response(JSON.stringify(me.body), { status: me.status });
      return new Response(JSON.stringify({ unreadCount: 0 }), { status: 200 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<p>page</p>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Layout', () => {
  it('visitors see only sign in and sign up', async () => {
    renderAs({ status: 200, body: { user: null } });
    expect(await screen.findByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('navigation', { name: 'App sections' })).not.toBeInTheDocument();
  });

  it('readers get News, Saved and Alerts — no way to post', async () => {
    renderAs({ status: 200, body: { user: { ...base, roles: ['reader'] } } });
    const tabs = await screen.findByRole('navigation', { name: 'App sections' });
    expect(tabs).toHaveTextContent('News');
    expect(tabs).toHaveTextContent('Saved');
    expect(screen.queryByRole('link', { name: /Post news/ })).not.toBeInTheDocument();
  });

  it('reporters also get the Post button and My posts', async () => {
    renderAs({ status: 200, body: { user: { ...base, roles: ['reader', 'reporter'] } } });
    const tabs = await screen.findByRole('navigation', { name: 'App sections' });
    expect(tabs).toHaveTextContent('My posts');
    expect(screen.getAllByRole('link', { name: /Post news/ }).length).toBeGreaterThan(0);
  });

  it('signing out really signs out: the header switches to Sign up at once (regression)', async () => {
    let signedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/logout') && init?.method === 'POST') {
          signedIn = false;
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/auth/session')) return new Response(JSON.stringify({ user: signedIn ? { ...base, roles: ['reader'] } : null }), { status: 200 });
        return new Response(JSON.stringify({ unreadCount: 0 }), { status: 200 });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AuthProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<p>page</p>} />
              </Route>
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Your menu' }));
    expect(screen.getByText('ravi@example.in')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('link', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByText('ravi@example.in')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Your menu' })).not.toBeInTheDocument();
  });

  it('readers see "Become a reporter" in their menu', async () => {
    renderAs({ status: 200, body: { user: { ...base, roles: ['reader'] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Your menu' }));
    expect(screen.getByRole('menuitem', { name: 'Become a reporter' })).toHaveAttribute('href', '/account#reporter');
  });
});
