import type { Submission, TrackRecord } from '@locallens/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppealBox, TrackRecordView } from '../components/Accountability';

const record: TrackRecord = {
  tier: 'trusted',
  windowDays: 180,
  published: 6,
  rejected: 1,
  rejectedByReason: { duplicate: 1 },
  returnedForChanges: 2,
  corrections: 0,
  retractions: 0,
  appealsOverturned: 1,
  queueHeadStartHours: 12,
};

describe('TrackRecordView', () => {
  it('shows every count, the reasons and the rules behind the tier', () => {
    render(<TrackRecordView record={record} own />);
    expect(screen.getByText('Trusted reporter')).toBeInTheDocument();
    expect(screen.getByText('6 published')).toBeInTheDocument();
    expect(screen.getByText('1 not published')).toBeInTheDocument();
    expect(screen.getByText('1 appeal accepted')).toBeInTheDocument();
    expect(screen.getByText(/Already reported \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('Your reports get a 12-hour head start in the review queue.')).toBeInTheDocument();
    expect(screen.getByText('How this works')).toBeInTheDocument();
  });
});

describe('AppealBox', () => {
  const base = { status: 'rejected', appeal: null, appealUntil: '2026-11-10T00:00:00.000Z' } as unknown as Submission;

  it('needs a real reason before an appeal can be sent', async () => {
    const onAppeal = vi.fn(async () => undefined);
    render(<AppealBox sub={base} onAppeal={onAppeal} />);
    const send = screen.getByRole('button', { name: 'Send appeal' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why should the decision change?'), 'The panchayat notice confirms the date.');
    await userEvent.click(send);
    expect(onAppeal).toHaveBeenCalledWith('The panchayat notice confirms the date.');
  });

  it('shows the outcome instead of the form once decided', () => {
    render(<AppealBox sub={{ ...base, appealUntil: null, appeal: { status: 'upheld', note: 'x', decisionNote: 'Still no source.', createdAt: '', decidedAt: '' } }} onAppeal={vi.fn()} />);
    expect(screen.getByText('Appeal decided: the decision stands')).toBeInTheDocument();
    expect(screen.getByText('Still no source.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send appeal' })).not.toBeInTheDocument();
  });
});
