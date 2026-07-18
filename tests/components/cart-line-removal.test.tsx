// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDB, getDB, mutate, resetDemo } from '../../src/lib/store';
import { removeCartItemWithSync, CART_REMOVAL_MESSAGE } from '../../src/lib/cart-sync';
import type { CartItem, Registration } from '../../src/lib/types';

function CartHarness({ ownerKey }: { ownerKey: string }) {
  const db = useDB();
  const items = db.carts[ownerKey] ?? [];
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id}>
          <span>{i.label}</span>
          <button
            aria-label={`Remove ${i.label} from cart`}
            onClick={() => {
              const { action, keptRegIds } = removeCartItemWithSync(ownerKey, false, i);
              const el = document.getElementById('toast')!;
              el.textContent = action === 'blocked-offline' ? '' : CART_REMOVAL_MESSAGE[action] + (keptRegIds.length ? ' kept' : '');
            }}
          >
            ✕
          </button>
        </li>
      ))}
      <div id="toast" />
    </ul>
  );
}

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'r1', eventId: 'e1', athleteId: 'a1', clubId: 'club-a', discipline: 'MAG',
    levelId: 'L5', apparatus: ['FX', 'PH'], sessionId: null,
    ...overrides,
  };
}

function cartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: 'ci1', label: 'MAG entry — Athlete', amount: 40, kind: 'meet-entry',
    ...overrides,
  };
}

const OWNER = 'a1';

beforeEach(() => {
  resetDemo();
  mutate((d) => {
    d.registrations = [];
    d.carts[OWNER] = [];
  });
});

describe('cart line removal semantics (Cart.tsx ✕ + cart-sync integration)', () => {
  it('unpaid entry line with refRegIds deletes the linked registration', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1' }));
      d.carts[OWNER] = [cartItem({ id: 'ci1', refLineType: 'entry', refRegIds: ['r1'] })];
    });
    render(<CartHarness ownerKey={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove MAG entry/ }));
    expect(getDB().registrations.find((r) => r.id === 'r1')).toBeUndefined();
    expect(getDB().carts[OWNER]).toHaveLength(0);
    expect(document.getElementById('toast')!.textContent).toBe('Removed from cart and canceled the registration.');
  });

  it('change line with prior_reg_snapshot reverts the registration to its prior state', () => {
    const prior = reg({ id: 'r1', apparatus: ['FX'], levelId: 'L4' });
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', apparatus: ['FX', 'PH', 'SR'], levelId: 'L5' }));
      d.carts[OWNER] = [cartItem({
        id: 'ci1', label: 'MAG change — Athlete', refLineType: 'change',
        refRegIds: ['r1'], priorRegSnapshot: [prior],
      })];
    });
    render(<CartHarness ownerKey={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove MAG change/ }));
    const reverted = getDB().registrations.find((r) => r.id === 'r1');
    expect(reverted?.apparatus).toEqual(['FX']);
    expect(reverted?.levelId).toBe('L4');
    expect(document.getElementById('toast')!.textContent).toBe('Removed from cart — registration reverted to its prior state.');
  });

  it('legacy change line without a snapshot removes only the line and shows the honest no-revert toast', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', apparatus: ['FX', 'PH'] }));
      d.carts[OWNER] = [cartItem({
        id: 'ci1', label: 'MAG change — Athlete', refLineType: 'change',
        refRegIds: ['r1'], priorRegSnapshot: undefined,
      })];
    });
    render(<CartHarness ownerKey={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove MAG change/ }));
    const untouched = getDB().registrations.find((r) => r.id === 'r1');
    expect(untouched?.apparatus).toEqual(['FX', 'PH']);
    expect(getDB().carts[OWNER]).toHaveLength(0);
    expect(document.getElementById('toast')!.textContent).toBe(
      'Removed from cart. This registration was changed before we could track a revert — please check it.',
    );
  });

  it('a line with no refRegIds is remove-only and leaves every registration untouched', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1' }));
      d.carts[OWNER] = [cartItem({ id: 'ci1', label: 'T-shirt add-on', kind: 'addon', refLineType: 'tshirt' })];
    });
    render(<CartHarness ownerKey={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove T-shirt add-on/ }));
    expect(getDB().registrations.find((r) => r.id === 'r1')).toBeDefined();
    expect(getDB().carts[OWNER]).toHaveLength(0);
    expect(document.getElementById('toast')!.textContent).toBe('Removed from cart.');
  });
});
