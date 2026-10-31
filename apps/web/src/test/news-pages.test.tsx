import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { ArticlePage } from '../pages/ArticlePage';
import { HomePage, NewsPage } from '../pages/HomePage';

function mockApi(routes: Record<string, { status: number; body?: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace('/api/v1', '').split('?')[0]}`;
      const reply = routes[key] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nf' } } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
    }),
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/news" element={<NewsPage />} />
            <Route path="/articles/:slug" element={<ArticlePage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const anonymous = { status: 200, body: { user: null } };
const location = { id: 'l1', level: 'mandal', parentId: 'd1', name: { en: 'Tenali', te: 'తెనాలి' }, lgdCode: null, label: 'Tenali, Guntur', labelTe: 'తెనాలి, గుంటూరు' };
const category = { id: 'c1', slug: 'civic_issues', name: { en: 'Civic issues', te: 'పౌర సమస్యలు' } };
const summary = {
  id: 'a1',
  slug: 'water-supply-restored-12345678',
  status: 'published',
  headline: 'Water supply restored',
  summary: 'Supply resumed after pipeline repairs.',
  language: 'en',
  location,
  category,
  trustLabel: 'editor_verified',
  sourceType: 'staff',
  firstPublishedAt: '2026-10-10T04:30:00.000Z',
  lastUpdatedAt: '2026-10-10T06:00:00.000Z',
  correctionCount: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe('HomePage', () => {
  it('shows visitors a landing page with sign-up, reading, and the latest news', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'GET /config': { status: 200, body: { reporterSelfSignup: true, removeAfterReports: 10 } },
      'GET /articles': { status: 200, body: { items: [summary], nextCursor: null } },
    });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Your village news, in one minute.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create free account' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: 'Read the news' })).toHaveAttribute('href', '/news');
    expect(screen.getByRole('link', { name: 'Sign up as a reporter' })).toHaveAttribute('href', '/register?as=reporter');
    expect(await screen.findByText(/When 10 people report a post/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Water supply restored/ })).toHaveAttribute('href', '/articles/water-supply-restored-12345678');
  });

  it('the news page shows one story per card with topic, place, trust label and correction count', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'GET /categories': { status: 200, body: { items: [category] } },
      'GET /articles': { status: 200, body: { items: [summary], nextCursor: null } },
    });
    renderAt('/news');
    // One story per card: headline, summary and a "Read full story" link to the article.
    const card = await screen.findByRole('article', { name: 'Water supply restored' });
    expect(card).toHaveTextContent('Supply resumed after pipeline repairs.');
    expect(screen.getByRole('link', { name: 'Read full story' })).toHaveAttribute('href', '/articles/water-supply-restored-12345678');
    expect(screen.getByRole('button', { name: /Report/ })).toBeInTheDocument();
    expect(screen.getByText('Tenali, Guntur')).toBeInTheDocument();
    expect(screen.getByText('Verified by LocalLens')).toBeInTheDocument();
    expect(screen.getByText(/corrected once/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Civic issues' })).toBeInTheDocument();
  });
});

describe('imported news', () => {
  it('shows the news site name and opens the story on LocalLens itself (no jump to the other site)', async () => {
    const imported = {
      ...summary,
      id: 'e1',
      slug: 'cyclone-warning-abcdef12',
      headline: 'Cyclone warning for coastal Andhra Pradesh',
      trustLabel: 'external_source',
      sourceType: 'external',
      imageUrl: 'https://img.news.example/cyclone.jpg',
      externalSource: { name: 'The Hindu', url: 'https://www.thehindu.com/news/x.ece' },
    };
    mockApi({
      'GET /auth/session': anonymous,
      'GET /categories': { status: 200, body: { items: [category] } },
      'GET /articles': { status: 200, body: { items: [imported], nextCursor: null } },
    });
    renderAt('/news');
    expect(await screen.findByRole('link', { name: 'Read full story' })).toHaveAttribute('href', '/articles/cyclone-warning-abcdef12');
    expect(screen.getByText('The Hindu')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Read on/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="https://www.thehindu.com"]')).toBeNull();
  });
});

describe('ArticlePage', () => {
  it('shows the correction history with public notes', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'GET /articles/water-supply-restored-12345678': {
        status: 200,
        body: {
          article: {
            ...summary,
            body: 'First paragraph.\n\nSecond paragraph.',
            originalSourceUrl: null,
            history: [
              { revisionNumber: 1, changeKind: 'initial', publicNote: null, createdAt: '2026-10-10T04:30:00.000Z' },
              { revisionNumber: 2, changeKind: 'correction', publicNote: 'Corrected the date of the repair.', createdAt: '2026-10-10T06:00:00.000Z' },
            ],
          },
        },
      },
    });
    renderAt('/articles/water-supply-restored-12345678');
    expect(await screen.findByRole('heading', { name: 'Water supply restored' })).toBeInTheDocument();
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument();
    expect(screen.getByText('Correction')).toBeInTheDocument();
    expect(screen.getByText('Corrected the date of the repair.')).toBeInTheDocument();
  });

  it('shows a retraction notice and no body for retracted articles', async () => {
    mockApi({
      'GET /auth/session': anonymous,
      'GET /articles/water-supply-restored-12345678': {
        status: 200,
        body: {
          article: {
            ...summary,
            status: 'retracted',
            body: null,
            originalSourceUrl: null,
            history: [{ revisionNumber: 2, changeKind: 'retraction', publicNote: 'The report could not be confirmed.', createdAt: '2026-10-10T06:00:00.000Z' }],
          },
        },
      },
    });
    renderAt('/articles/water-supply-restored-12345678');
    expect(await screen.findByText('This article has been retracted.')).toBeInTheDocument();
    expect(screen.getAllByText('The report could not be confirmed.').length).toBeGreaterThan(0);
  });

  it('says clearly when an article does not exist', async () => {
    mockApi({ 'GET /auth/session': anonymous });
    renderAt('/articles/missing-article');
    expect(await screen.findByText('This article does not exist or is no longer available.')).toBeInTheDocument();
  });
});
