import { describe, expect, it } from 'vitest';
import { optionalString, requireGroupId, requireNumber, requireString } from '../../src/mcp/validate';

describe('mcp/validate', () => {
  describe('requireString', () => {
    it('returns { value } for valid string', () => {
      const result = requireString({ name: 'hello' }, 'name');
      expect(result).toEqual({ value: 'hello' });
    });

    it('returns { error } for missing param', () => {
      const result = requireString({}, 'name');
      expect(result.error).toBeDefined();
      expect(result.error?.isError).toBe(true);
      expect(result.error?.content[0].text).toContain('name');
    });

    it('returns { error } for non-string param', () => {
      const result = requireString({ name: 42 }, 'name');
      expect(result.error).toBeDefined();
      expect(result.error?.isError).toBe(true);
      expect(result.error?.content[0].text).toContain('name');
    });

    it('returns { error } for empty string', () => {
      const result = requireString({ name: '' }, 'name');
      expect(result.error).toBeDefined();
      expect(result.error?.isError).toBe(true);
      expect(result.error?.content[0].text).toContain('name');
    });
  });

  describe('requireNumber', () => {
    it('returns { value } for valid number', () => {
      const result = requireNumber({ count: 5 }, 'count');
      expect(result).toEqual({ value: 5 });
    });

    it('returns { error } for missing param', () => {
      const result = requireNumber({}, 'count');
      expect(result.error).toBeDefined();
      expect(result.error?.isError).toBe(true);
      expect(result.error?.content[0].text).toContain('count');
    });

    it('returns { error } for non-number param', () => {
      const result = requireNumber({ count: 'five' }, 'count');
      expect(result.error).toBeDefined();
      expect(result.error?.isError).toBe(true);
      expect(result.error?.content[0].text).toContain('count');
    });
  });

  describe('requireGroupId', () => {
    it('returns null for valid groupId', () => {
      expect(requireGroupId('test-group-1')).toBeNull();
    });

    it('returns error ToolResult for empty groupId', () => {
      const result = requireGroupId('');
      expect(result).not.toBeNull();
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('group');
    });
  });

  describe('optionalString', () => {
    it('returns value if string present', () => {
      expect(optionalString({ color: 'red' }, 'color', 'blue')).toBe('red');
    });

    it('returns default if missing', () => {
      expect(optionalString({}, 'color', 'blue')).toBe('blue');
    });

    it('returns default if wrong type', () => {
      expect(optionalString({ color: 42 }, 'color', 'blue')).toBe('blue');
    });
  });
});
