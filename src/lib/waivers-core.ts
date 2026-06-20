// Pure waiver logic — zero runtime deps so it runs under node/vitest.
import type { WaiverSignature } from './types';

/** SHA-256 hex digest of a string (Web Crypto; Node 20+ and browsers). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Next per-(season,type) version number given existing versions. */
export function nextVersion(existing: { version: number }[]): number {
  return existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

/** True when the person is under 18 at `on` (false if dob missing). */
export function isMinorAt(dob: string, on: Date): boolean {
  if (!dob?.trim()) return false;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return false;
  let age = on.getFullYear() - birth.getFullYear();
  const m = on.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < birth.getDate())) age--;
  return age < 18;
}

export type RequestStatus = 'pending' | 'completed' | 'expired';

/** Token state machine. 'pending' is the only non-terminal state. */
export function advanceRequest(
  status: RequestStatus, action: 'complete' | 'expire',
): RequestStatus {
  if (status !== 'pending') return status;
  return action === 'complete' ? 'completed' : 'expired';
}

/** Human-readable, regenerated-on-demand signing certificate.
 *  `athleteName` is the membership holder; for guardian signatures the signer
 *  differs from the holder. */
export function certificateText(
  sig: WaiverSignature, version: number, athleteName: string,
): string {
  const when = new Date(sig.signedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const who = sig.signerRole === 'guardian'
    ? `${athleteName}'s guardian ${sig.signerName}` +
      (sig.signerRelationship ? ` (${sig.signerRelationship})` : '')
    : `${sig.signerName}`;
  return `${who} agreed to ${sig.waiverType} Waiver v${version} ` +
    `(hash ${sig.contentHash}) on ${when} from IP ${sig.ip ?? 'unknown'} ` +
    `(consent: ${sig.consent ? 'yes' : 'no'}).`;
}
