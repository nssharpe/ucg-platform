import { describe, it, expect } from 'vitest';
import { normalizePhone, isStopKeyword, parseTelnyxWebhook } from '../src/lib/sms-inbound';

describe('normalizePhone', () => {
  it('reduces US numbers in any format to the last 10 digits', () => {
    expect(normalizePhone('+15551234567')).toBe('5551234567');
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('1-555-123-4567')).toBe('5551234567');
  });
  it('returns the digits as-is when fewer than 10', () => {
    expect(normalizePhone('12345')).toBe('12345');
    expect(normalizePhone('')).toBe('');
  });
});

describe('isStopKeyword', () => {
  it('matches the CTIA stop keywords regardless of case/whitespace', () => {
    for (const kw of ['STOP', 'stop', '  Stop ', 'STOPALL', 'unsubscribe', 'cancel', 'end', 'quit']) {
      expect(isStopKeyword(kw)).toBe(true);
    }
  });
  it('does not match ordinary replies', () => {
    expect(isStopKeyword('please stop sending')).toBe(false); // multi-word is not a bare keyword
    expect(isStopKeyword('thanks!')).toBe(false);
    expect(isStopKeyword('START')).toBe(false);
  });
});

describe('parseTelnyxWebhook', () => {
  it('classifies an inbound message', () => {
    const ev = parseTelnyxWebhook({
      data: {
        event_type: 'message.received',
        payload: { id: 'msg-1', direction: 'inbound', from: { phone_number: '+15551234567' }, to: [{ phone_number: '+16787988123' }], text: 'STOP' },
      },
    });
    expect(ev).toEqual({ kind: 'inbound', messageId: 'msg-1', from: '+15551234567', text: 'STOP' });
  });
  it('classifies an outbound delivery receipt with the recipient status', () => {
    const ev = parseTelnyxWebhook({
      data: {
        event_type: 'message.finalized',
        payload: { id: 'msg-2', direction: 'outbound', from: { phone_number: '+16787988123' }, to: [{ phone_number: '+15551234567', status: 'delivered' }], text: 'hi' },
      },
    });
    expect(ev).toEqual({ kind: 'dlr', messageId: 'msg-2', to: '+15551234567', status: 'delivered' });
  });
  it('returns other for unrecognized / malformed payloads', () => {
    expect(parseTelnyxWebhook({}).kind).toBe('other');
    expect(parseTelnyxWebhook({ data: { event_type: 'number.something' } }).kind).toBe('other');
  });
});
