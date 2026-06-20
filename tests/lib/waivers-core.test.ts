import { describe, it, expect } from 'vitest';
import {
  sha256Hex, nextVersion, isMinorAt, advanceRequest, certificateText,
} from '../../src/lib/waivers-core';
import type { WaiverSignature } from '../../src/lib/types';

describe('sha256Hex', () => {
  it('is stable and matches the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('differs when text differs', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});

describe('nextVersion', () => {
  it('starts at 1 with no prior versions', () => {
    expect(nextVersion([])).toBe(1);
  });
  it('returns max+1', () => {
    expect(nextVersion([{ version: 1 }, { version: 3 }, { version: 2 }])).toBe(4);
  });
});

describe('isMinorAt', () => {
  it('true when under 18 at the given date', () => {
    expect(isMinorAt('2010-06-20', new Date('2026-06-20T00:00:00Z'))).toBe(true);
  });
  it('false on the 18th birthday', () => {
    expect(isMinorAt('2008-06-20', new Date('2026-06-20T00:00:00Z'))).toBe(false);
  });
  it('false when dob missing', () => {
    expect(isMinorAt('', new Date('2026-06-20T00:00:00Z'))).toBe(false);
  });
});

describe('advanceRequest', () => {
  it('pending -> completed', () => {
    expect(advanceRequest('pending', 'complete')).toBe('completed');
  });
  it('pending -> expired', () => {
    expect(advanceRequest('pending', 'expire')).toBe('expired');
  });
  it('completed is terminal', () => {
    expect(advanceRequest('completed', 'complete')).toBe('completed');
    expect(advanceRequest('completed', 'expire')).toBe('completed');
  });
});

describe('certificateText', () => {
  const sig: WaiverSignature = {
    id: 's1', personId: 'p1', seasonId: '2026', waiverType: 'Athlete',
    waiverDocumentId: 'd1', contentHash: 'abc123', signerName: 'John Doe',
    signerEmail: 'john@example.com', signerRole: 'guardian', signerRelationship: 'parent',
    consent: true, signedAt: '2026-06-20T14:02:00Z', ip: '1.2.3.4', userAgent: 'UA',
  };
  it('renders a guardian certificate with version, hash, ip, consent', () => {
    const txt = certificateText(sig, 3, 'Jane Doe');
    expect(txt).toContain('Jane Doe');
    expect(txt).toContain('guardian John Doe (parent)');
    expect(txt).toContain('Athlete Waiver v3');
    expect(txt).toContain('abc123');
    expect(txt).toContain('1.2.3.4');
    expect(txt).toContain('consent: yes');
  });
  it('renders a self certificate without the guardian clause', () => {
    const self = { ...sig, signerRole: 'self' as const, signerRelationship: null };
    const txt = certificateText(self, 1, 'John Doe');
    expect(txt).toContain('John Doe agreed to');
    expect(txt).not.toContain('guardian');
  });
});
