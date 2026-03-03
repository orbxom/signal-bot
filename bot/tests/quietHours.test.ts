import { afterEach, describe, expect, it, vi } from 'vitest';
import { isQuietHours } from '../src/index';

// March 2026: Australia/Sydney is AEDT (UTC+11)

describe('isQuietHours', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setFakeTime = (isoString: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoString));
  };

  it('should return true at 9pm (21:00)', () => {
    // 21:00 AEDT = 10:00 UTC
    setFakeTime('2026-03-03T10:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(true);
  });

  it('should return true at 11pm (23:00)', () => {
    // 23:00 AEDT = 12:00 UTC
    setFakeTime('2026-03-03T12:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(true);
  });

  it('should return true at 3am', () => {
    // 03:00 AEDT = 16:00 UTC (previous day)
    setFakeTime('2026-03-02T16:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(true);
  });

  it('should return true at midnight', () => {
    // 00:00 AEDT = 13:00 UTC (previous day)
    setFakeTime('2026-03-02T13:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(true);
  });

  it('should return true at 5am (still quiet)', () => {
    // 05:00 AEDT = 18:00 UTC (previous day)
    setFakeTime('2026-03-02T18:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(true);
  });

  it('should return false at 6am (quiet ends)', () => {
    // 06:00 AEDT = 19:00 UTC (previous day)
    setFakeTime('2026-03-02T19:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(false);
  });

  it('should return false at noon', () => {
    // 12:00 AEDT = 01:00 UTC
    setFakeTime('2026-03-03T01:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(false);
  });

  it('should return false at 8pm (20:00)', () => {
    // 20:00 AEDT = 09:00 UTC
    setFakeTime('2026-03-03T09:00:00Z');
    expect(isQuietHours('Australia/Sydney')).toBe(false);
  });
});
