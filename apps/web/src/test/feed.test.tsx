import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { ShortsFeed } from '../components/Shorts';
import { formatWhen } from '../lib/format';

const story = (id: string, headline: string, at: string) => ({
  id,
  slug: `${id}-slug-12345678`,
  status: 'published',
  headline,
  summary: 'Summary.',
  language: 'en',
  location: { id: 'l1', level: 'district', parentId: null, name: { en: 'Guntur', te: 'గుంటూరు' }, lgdCode: null, label: 'Guntur', labelTe: 'గుంటూరు' },
  category: { id: 'c1', slug: 'civic_issues', name: { en: 'Civic issues', te: 'పౌర సమస్యలు' } },
  trustLabel: 'external_source',
  sourceType: 'external',
  firstPublishedAt: at,
  lastUpdatedAt: at,
  correctionCount: 0,
  deadline: null,
  imageUrl: null,
  externalSource: { name: 'TV9 Telugu', url: 'https://tv9telugu.com/x' },
});

afterEach(() => vi.unstubAllGlobals());

describe('ShortsFeed', () => {
  it('offers "New stories" when fresher news arrives, without sending the limit twice', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/auth/session')) return new Response(JSON.stringify({ user: null }), { status: 200 });
        if (url.includes('/config')) return new Response(JSON.stringify({ reporterSelfSignup: true, removeAfterReports: 10 }), { status: 200 });
        const items = url.includes('limit=1') && !url.includes('limit=10') ? [story('new', 'Fresh story', '2026-10-29T13:00:00Z')] : [story('old', 'Older story', '2026-10-29T10:00:00Z')];
        return new Response(JSON.stringify({ items, nextCursor: null }), { status: 200 });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AuthProvider>
            <ShortsFeed queryKey={['feed', 'test']} path="/articles?limit=10" emptyText="none" />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Older story' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /New stories/ })).toBeInTheDocument();
    const head = urls.find((u) => u.includes('limit=1') && !u.includes('limit=10'))!;
    expect(head.match(/limit=/g)).toHaveLength(1);
  });
});

describe('formatWhen', () => {
  it('says Today / Yesterday in India time, and the full date otherwise', () => {
    const now = new Date('2026-10-29T12:00:00Z'); // 5:30 pm IST
    const labels = { today: 'Today', yesterday: 'Yesterday' };
    expect(formatWhen('2026-10-29T06:00:00Z', 'en', labels, now)).toMatch(/^Today, 11:30\s?am$/i);
    expect(formatWhen('2026-10-28T06:00:00Z', 'en', labels, now)).toMatch(/^Yesterday, /);
    expect(formatWhen('2026-10-20T06:00:00Z', 'en', labels, now)).not.toMatch(/Today|Yesterday/);
  });
});
