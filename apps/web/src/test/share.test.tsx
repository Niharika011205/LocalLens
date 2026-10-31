import type { ArticleSummary } from '@locallens/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareButton } from '../components/ShareButton';

const article = { id: 'a1', slug: 'water-supply-restored-12345678', headline: 'Water supply restored', summary: 'Supply resumed.', language: 'en' } as unknown as ArticleSummary;

afterEach(() => vi.unstubAllGlobals());

describe('ShareButton', () => {
  it('offers WhatsApp, Telegram, Facebook and X links with the story link', async () => {
    render(<ShareButton article={article} className="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const link = `${location.origin}/articles/water-supply-restored-12345678`;
    expect(screen.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', `https://wa.me/?text=${encodeURIComponent(`Water supply restored\n${link}`)}`);
    expect(screen.getByRole('link', { name: 'Telegram' }).getAttribute('href')).toContain(encodeURIComponent(link));
    expect(screen.getByRole('link', { name: 'Facebook' }).getAttribute('href')).toContain(encodeURIComponent(link));
    expect(screen.getByRole('link', { name: 'X' }).getAttribute('href')).toContain(encodeURIComponent(link));
  });

  it('copies the link even where the clipboard API is missing (plain http), and says so on screen', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined, share: undefined });
    const exec = vi.fn(() => true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    render(<ShareButton article={article} className="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.queryByRole('button', { name: 'More…' })).not.toBeInTheDocument(); // no native share here
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(await screen.findByRole('button', { name: 'Link copied ✓' })).toBeInTheDocument();
  });
});
