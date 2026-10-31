import type { ArticleSummary } from '@locallens/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { ReportButton } from '../components/Shorts';
import { PostNewsPage } from '../pages/PostPages';

const user = {
  id: 'a'.repeat(24),
  email: 'ravi@example.in',
  displayName: 'Ravi',
  preferredLanguage: 'en',
  roles: ['reader', 'reporter'],
  status: 'active',
  reporterRequest: { status: 'approved', requestedAt: null, decidedAt: null, note: null },
  mustChangePassword: false,
  mfa: { enabled: false, requiredForRoles: false },
  createdAt: '2026-10-10T00:00:00.000Z',
};
const article = {
  id: 'b'.repeat(24),
  slug: 'tank-cleaned-12345678',
  headline: 'Tank cleaned',
  summary: 'The panchayat cleaned the tank.',
  trustLabel: 'reporter_post',
} as unknown as ArticleSummary;

function mockApi(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace('/api/v1', '').split('?')[0]}`;
      calls.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const reply = routes[key] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nf' } } };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return calls;
}

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ReportButton', () => {
  it('reports in two taps, explains automatic removal, and says when the post was removed', async () => {
    const calls = mockApi({
      'GET /auth/session': { status: 200, body: { user } },
      'GET /config': { status: 200, body: { reporterSelfSignup: true, removeAfterReports: 10 } },
      [`POST /articles/${article.id}/reports`]: { status: 201, body: { message: 'x', removed: true } },
    });
    const onRemoved = vi.fn();
    wrap(<ReportButton article={article} onRemoved={onRemoved} />);
    await userEvent.click(await screen.findByRole('button', { name: /Report/ }));
    expect(await screen.findByText(/removed automatically when 10 different people report them/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Spam' }));
    expect(await screen.findByText(/Enough people reported this post, so it has been removed/)).toBeInTheDocument();
    expect(onRemoved).toHaveBeenCalled();
    expect(calls.find((c) => c.key.startsWith('POST /articles'))?.body).toEqual({ reason: 'spam' });
  });
});

describe('PostNewsPage', () => {
  it('checks the form before uploading: place and topic are required, the summary is capped for one screen', async () => {
    const calls = mockApi({
      'GET /auth/session': { status: 200, body: { user } },
      'GET /categories': { status: 200, body: { items: [{ id: 'c'.repeat(24), slug: 'civic_issues', name: { en: 'Civic issues', te: 'పౌర సమస్యలు' } }] } },
    });
    wrap(<PostNewsPage />);
    await userEvent.type(await screen.findByLabelText('Headline'), 'Tank cleaned in the village');
    await userEvent.type(screen.getByLabelText('The news in a few lines'), 'The panchayat cleaned the overhead tank today.');
    expect(screen.getByText(/7 words · 46\/560 characters/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Post now' }));
    expect(screen.getByText('Choose the village, mandal or district.')).toBeInTheDocument();
    expect(screen.getByText('Choose a topic.')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /posts')).toBe(false);
    expect(screen.getByText(/Location and camera details are removed/)).toBeInTheDocument();
  });
});
