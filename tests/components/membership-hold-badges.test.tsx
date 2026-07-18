// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../src/components/ui';
import { membershipHolds } from '../../src/lib/capabilities-core';
import type { Membership } from '../../src/lib/types';

// Reproduces Club.tsx's roster-cell rendering (src/pages/Club.tsx, the
// membershipHolds() branch around the "None"/active/waiver/payment badges) as
// a standalone harness — that branch is inlined in a large non-exported page
// component, so this locks the actual membershipHolds() derivation + Badge
// rendering without mounting all of Club.tsx's router/capabilities context.
function HoldBadges({ m, seasonName = '2025–26' }: { m: Membership | undefined; seasonName?: string }) {
  if (!m) return <Badge tone="err">None</Badge>;
  const h = membershipHolds(m);
  if (h.active) return <Badge tone="ok">✓ {seasonName}</Badge>;
  if (h.waiverHold || h.paymentHold) {
    return (
      <div>
        {h.waiverHold && <Badge tone="warn">Pending waiver</Badge>}
        {h.paymentHold && <Badge tone="warn">Pending club $</Badge>}
      </div>
    );
  }
  return <Badge tone="err">None</Badge>;
}

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    seasonId: 's26', type: 'athlete', status: 'active',
    waiverSignedAt: '2026-01-01T00:00:00Z', waiverSignedBy: 'Ada Lovelace', paidVia: 'card',
    ...overrides,
  };
}

describe('membership-hold badge rendering (membershipHolds, not the raw status enum)', () => {
  it('no membership row at all renders "None"', () => {
    render(<HoldBadges m={undefined} />);
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.queryByText(/Pending/)).not.toBeInTheDocument();
  });

  it('waiver hold only: waiverSignedAt null, no payment hold', () => {
    render(<HoldBadges m={membership({ waiverSignedAt: null, waiverSignedBy: null })} />);
    expect(screen.getByText('Pending waiver')).toBeInTheDocument();
    expect(screen.queryByText('Pending club $')).not.toBeInTheDocument();
    expect(screen.queryByText(/^✓/)).not.toBeInTheDocument();
  });

  it('payment hold only: clubCartPending true, waiver signed', () => {
    render(<HoldBadges m={membership({ clubCartPending: true })} />);
    expect(screen.getByText('Pending club $')).toBeInTheDocument();
    expect(screen.queryByText('Pending waiver')).not.toBeInTheDocument();
    expect(screen.queryByText(/^✓/)).not.toBeInTheDocument();
  });

  it('both holds at once (minor awaiting guardian waiver AND club payment)', () => {
    render(<HoldBadges m={membership({ waiverSignedAt: null, waiverSignedBy: null, clubCartPending: true })} />);
    expect(screen.getByText('Pending waiver')).toBeInTheDocument();
    expect(screen.getByText('Pending club $')).toBeInTheDocument();
  });

  it('neither hold: fully active, renders the season checkmark badge and no hold bubbles', () => {
    render(<HoldBadges m={membership()} seasonName="2025–26" />);
    expect(screen.getByText('✓ 2025–26')).toBeInTheDocument();
    expect(screen.queryByText('Pending waiver')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending club $')).not.toBeInTheDocument();
  });

  it('legacy status fallback: status "pending-club-payment" with no clubCartPending flag still renders the payment hold', () => {
    render(<HoldBadges m={membership({ status: 'pending-club-payment', clubCartPending: undefined })} />);
    expect(screen.getByText('Pending club $')).toBeInTheDocument();
  });
});
