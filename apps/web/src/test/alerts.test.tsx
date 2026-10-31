import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daysUntil } from '../lib/format';
import { NotificationsPage } from '../pages/AlertsPages';

const istDay = (offset: number) => new Date(Date.now() + 5.5 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

afterEach(() => vi.unstubAllGlobals());

describe('deadlines', () => {
  it('counts whole days in India time', () => {
    // 20:00 UTC on 28 Oct is already 29 Oct in India
    const now = Date.parse('2026-10-28T20:00:00Z');
    expect(daysUntil('2026-10-29', now)).toBe(0);
    expect(daysUntil('2026-11-01', now)).toBe(3);
    expect(daysUntil('2026-10-28', now)).toBe(-1);
  });
});

describe('NotificationsPage', () => {
  it('lists alerts with what happened, links to the article, shows deadline countdowns and marks all read', async () => {
    const calls: { method: string; url: string }[] = [];
    let unread = 2;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        if (method === 'POST') {
          unread = 0;
          return new Response(JSON.stringify({ unreadCount: 0 }), { status: 200 });
        }
        const article = (id: string, headline: string, deadline: string | null) => ({ id, slug: `${id}-slug`, headline, deadline });
        return new Response(
          JSON.stringify({
            items: [
              { id: 'n2', kind: 'deadline_soon', article: article('a2', 'Pension applications close soon', istDay(2)), createdAt: '2026-10-28T04:00:00Z', readAt: unread ? null : '2026-10-28T05:00:00Z' },
              { id: 'n1', kind: 'article_corrected', article: article('a1', 'Road repairs start', null), createdAt: '2026-10-27T04:00:00Z', readAt: unread ? null : '2026-10-28T05:00:00Z' },
            ],
            nextCursor: null,
            unreadCount: unread,
          }),
          { status: 200 },
        );
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <NotificationsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('link', { name: 'Pension applications close soon' })).toHaveAttribute('href', '/articles/a2-slug');
    expect(screen.getByText(/Deadline soon/)).toBeInTheDocument();
    expect(screen.getByText('2 days left')).toBeInTheDocument();
    expect(screen.getByText(/Corrected — an article you saved/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/me/notifications/read'))).toBe(true);
    await screen.findByText('Alerts'); // re-rendered after refetch
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument();
  });
});
