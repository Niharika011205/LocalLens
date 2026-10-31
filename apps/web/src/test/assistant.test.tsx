import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { AssistantPanel } from '../components/AssistantPanel';

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

function mockApi(me: { status: number; body: unknown }, ask?: { status: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const reply = url.endsWith('/auth/session') ? me : (ask ?? { status: 500, body: null });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return calls;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>
          <AssistantPanel articleSlug="water-supply-restored-12345678" locationId={'b'.repeat(24)} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AssistantPanel', () => {
  it('asks signed-out readers to sign in', async () => {
    mockApi({ status: 200, body: { user: null } });
    renderPanel();
    expect(await screen.findByRole('link', { name: /Sign in to ask/ })).toHaveAttribute('href', '/login');
  });

  it('shows the answer with links to the articles it is based on, and an AI disclaimer', async () => {
    const calls = mockApi(
      { status: 200, body: { user } },
      {
        status: 200,
        body: {
          status: 'answered',
          answer: 'Supply resumed on 10 October.',
          citations: [{ id: 'a1', slug: 'water-supply-restored-12345678', headline: 'Water supply restored' }],
          generatedBy: 'ollama:llama3.2',
          cached: false,
        },
      },
    );
    renderPanel();
    await userEvent.type(await screen.findByLabelText('Your question'), 'When did water come back?');
    await userEvent.selectOptions(screen.getByLabelText('Answer in'), 'en');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText('Supply resumed on 10 October.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Water supply restored' })).toHaveAttribute('href', '/articles/water-supply-restored-12345678');
    expect(screen.getByText(/It can make mistakes/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/assistant/ask'))?.body).toEqual({
      question: 'When did water come back?',
      language: 'en',
      simple: false,
      articleSlug: 'water-supply-restored-12345678',
      locationId: 'b'.repeat(24),
    });
  });

  it('says so plainly when the news does not cover the question', async () => {
    mockApi({ status: 200, body: { user } }, { status: 200, body: { status: 'insufficient_information', answer: '', citations: [], generatedBy: null, cached: false } });
    renderPanel();
    await userEvent.type(await screen.findByLabelText('Your question'), 'Who won the match?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/could not find enough information/)).toBeInTheDocument();
  });
});
