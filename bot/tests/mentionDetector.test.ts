import { describe, expect, it } from 'vitest';
import { MentionDetector } from '../src/mentionDetector';

describe('MentionDetector', () => {
  it('should detect bot mentions', () => {
    const detector = new MentionDetector(['@bot', 'bot:']);

    expect(detector.isMentioned('@bot hello')).toBe(true);
    expect(detector.isMentioned('bot: what time is it?')).toBe(true);
    expect(detector.isMentioned('hello everyone')).toBe(false);
  });

  it('should extract query from mentioned message', () => {
    const detector = new MentionDetector(['@bot', 'bot:']);

    expect(detector.extractQuery('@bot what is the weather?')).toBe('what is the weather?');
    expect(detector.extractQuery('bot: tell me a joke')).toBe('tell me a joke');
    expect(detector.extractQuery('hey @bot how are you')).toBe('hey @bot how are you');
  });

  describe('isMentioned', () => {
    it('should detect case-insensitive mentions', () => {
      const detector = new MentionDetector(['@bot']);

      expect(detector.isMentioned('@BOT hello')).toBe(true);
      expect(detector.isMentioned('@Bot hello')).toBe(true);
      expect(detector.isMentioned('@bot hello')).toBe(true);
    });

    it('should detect multiple trigger patterns', () => {
      const detector = new MentionDetector(['@bot', 'bot:', 'hey bot']);

      expect(detector.isMentioned('@bot hello')).toBe(true);
      expect(detector.isMentioned('bot: what time?')).toBe(true);
      expect(detector.isMentioned('hey bot how are you?')).toBe(true);
    });

    it('should handle empty content', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.isMentioned('')).toBe(false);
    });

    it('should handle special characters in content', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.isMentioned("@bot! What's up?")).toBe(true);
      // Mentions must be at the start of the message
      expect(detector.isMentioned('Hey @bot, help me.')).toBe(false);
    });
  });

  describe('extractQuery', () => {
    it('should handle multiple mentions in the same message', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.extractQuery('@bot @bot hello')).toBe('@bot hello');
    });

    it('should handle empty string after extraction', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.extractQuery('@bot')).toBe('');
    });

    it('should preserve punctuation and special characters', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.extractQuery("@bot what's the weather?")).toBe("what's the weather?");
    });

    it('should normalize whitespace', () => {
      const detector = new MentionDetector(['@bot']);
      expect(detector.extractQuery('@bot    hello    world')).toBe('hello world');
    });

    it('should remove all trigger patterns', () => {
      const detector = new MentionDetector(['@bot', 'bot:']);
      expect(detector.extractQuery('@bot bot: hello')).toBe('bot: hello');
    });

    it('should only strip triggers from the start of the message', () => {
      const detector = new MentionDetector(['c ']);
      // "c " appears inside "music scenes" — must NOT be stripped
      expect(detector.extractQuery('c tell me about music scenes')).toBe('tell me about music scenes');
      expect(detector.extractQuery('c describe the basic stuff')).toBe('describe the basic stuff');
    });

    it('should handle triggers with regex metacharacters safely', () => {
      const detector = new MentionDetector(['$bot', 'bot+', '[bot]']);

      expect(detector.extractQuery('$bot hello')).toBe('hello');
      expect(detector.extractQuery('bot+ what is up')).toBe('what is up');
      expect(detector.extractQuery('[bot] help me')).toBe('help me');
    });
  });
});
