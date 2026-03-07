import { describe, expect, it } from 'vitest';
import { computeNextDue, describeCron, isValidCron } from '../../src/utils/cron';

describe('cron utils', () => {
  describe('isValidCron', () => {
    it('should accept valid 5-field cron expressions', () => {
      expect(isValidCron('0 8 * * *')).toBe(true);
      expect(isValidCron('0 16 * * 2')).toBe(true);
      expect(isValidCron('*/15 * * * *')).toBe(true);
      expect(isValidCron('0 9 * * 1-5')).toBe(true);
    });

    it('should reject invalid expressions', () => {
      expect(isValidCron('not a cron')).toBe(false);
      expect(isValidCron('')).toBe(false);
      expect(isValidCron('60 * * * *')).toBe(false);
    });
  });

  describe('computeNextDue', () => {
    it('should return a future timestamp', () => {
      const now = Date.now();
      const next = computeNextDue('* * * * *', 'Australia/Sydney');
      expect(next).toBeGreaterThan(now - 1000);
    });

    it('should compute next occurrence after a given date', () => {
      const after = new Date('2026-01-15T07:00:00+11:00');
      const next = computeNextDue('0 8 * * *', 'Australia/Sydney', after);
      const nextDate = new Date(next);
      expect(nextDate.getTime()).toBeGreaterThan(after.getTime());
    });

    it('should respect timezone', () => {
      const after = new Date('2026-01-15T00:00:00Z');
      const sydneyNext = computeNextDue('0 8 * * *', 'Australia/Sydney', after);
      const londonNext = computeNextDue('0 8 * * *', 'Europe/London', after);
      expect(sydneyNext).not.toBe(londonNext);
    });
  });

  describe('describeCron', () => {
    it('should return formatted next occurrences', () => {
      const desc = describeCron('0 8 * * *', 'Australia/Sydney');
      expect(desc).toContain('8:00');
      expect(desc.split('\n').length).toBe(3);
    });
  });
});
