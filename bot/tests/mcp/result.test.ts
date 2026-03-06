import { describe, expect, it } from 'vitest';
import { catchErrors, error, estimateTokens, getErrorMessage, ok } from '../../src/mcp/result';

describe('mcp/result', () => {
  describe('ok', () => {
    it('returns content with text', () => {
      expect(ok('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });
  });

  describe('error', () => {
    it('returns content with text and isError true', () => {
      expect(error('bad')).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true });
    });
  });

  describe('catchErrors', () => {
    it('catches sync errors and returns error result with prefix', () => {
      const result = catchErrors(() => {
        throw new Error('boom');
      }, 'Failed to save');
      expect(result).toEqual({ content: [{ type: 'text', text: 'Failed to save: boom' }], isError: true });
    });

    it('catches async errors and returns error result with prefix', async () => {
      const result = await catchErrors(async () => {
        throw new Error('async boom');
      }, 'Failed to load');
      expect(result).toEqual({ content: [{ type: 'text', text: 'Failed to load: async boom' }], isError: true });
    });

    it('passes through successful sync results', () => {
      const result = catchErrors(() => ok('success'));
      expect(result).toEqual({ content: [{ type: 'text', text: 'success' }] });
    });

    it('passes through successful async results', async () => {
      const result = await catchErrors(async () => ok('async success'));
      expect(result).toEqual({ content: [{ type: 'text', text: 'async success' }] });
    });
  });

  describe('getErrorMessage', () => {
    it('extracts message from Error objects', () => {
      expect(getErrorMessage(new Error('test error'))).toBe('test error');
    });

    it('returns Unknown error for non-Error', () => {
      expect(getErrorMessage('string')).toBe('Unknown error');
      expect(getErrorMessage(42)).toBe('Unknown error');
      expect(getErrorMessage(null)).toBe('Unknown error');
      expect(getErrorMessage(undefined)).toBe('Unknown error');
    });
  });

  describe('estimateTokens', () => {
    it('returns Math.ceil(text.length / 4)', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('a')).toBe(1);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens('abcdefghijklmnop')).toBe(4);
    });
  });
});
