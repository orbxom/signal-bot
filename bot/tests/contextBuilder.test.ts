import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/contextBuilder';
import type { Message } from '../src/types';

describe('ContextBuilder', () => {
  const defaultConfig = {
    systemPrompt: '',
    timezone: 'Australia/Sydney',
    contextTokenBudget: 4000,
    attachmentsDir: './data/signal-attachments',
  };

  describe('buildContext', () => {
    it('should handle empty message history', () => {
      const builder = new ContextBuilder(defaultConfig);
      const chatMessages = builder.buildContext({ history: [], query: 'Hello' });

      expect(chatMessages).toHaveLength(2);
      expect(chatMessages[0].role).toBe('system');
      expect(chatMessages[1].role).toBe('user');
      expect(chatMessages[1].content).toBe('Hello');
    });

    it('should preserve message order', () => {
      const builder = new ContextBuilder(defaultConfig);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'First', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Bob', content: 'Second', timestamp: 2000, isBot: false },
        { id: 3, groupId: 'g1', sender: 'Charlie', content: 'Third', timestamp: 3000, isBot: false },
      ];

      const chatMessages = builder.buildContext({ history: messages, query: 'Query' });

      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: First');
      expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Bob: Second');
      expect(chatMessages[3].content).toBe('[1970-01-01 10:00] Charlie: Third');
    });

    it('should correctly format bot vs user messages', () => {
      const builder = new ContextBuilder(defaultConfig);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi!', timestamp: 2000, isBot: true },
      ];

      const chatMessages = builder.buildContext({ history: messages, query: 'How are you?' });

      expect(chatMessages[1].role).toBe('user');
      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: Hello');
      expect(chatMessages[2].role).toBe('assistant');
      expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Hi!');
    });

    it('should always include system prompt first', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'You are a helpful assistant.' });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
      ];

      const chatMessages = builder.buildContext({ history: messages, query: 'Query' });

      expect(chatMessages[0].role).toBe('system');
      expect(chatMessages[0].content).toBe('You are a helpful assistant.');
    });

    it('should use custom system prompt', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'You are a pirate.' });
      const chatMessages = builder.buildContext({ history: [], query: 'Query' });

      expect(chatMessages[0].content).toBe('You are a pirate.');
    });

    it('should always append current query last', () => {
      const builder = new ContextBuilder(defaultConfig);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
      ];

      const chatMessages = builder.buildContext({ history: messages, query: 'What is 2+2?' });
      const lastMessage = chatMessages[chatMessages.length - 1];

      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('What is 2+2?');
    });

    it('should include dossier context in system prompt when provided', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'You are a helpful bot.' });
      const dossierContext = '## People in this group\n- Alice (+61400000001)\n  Loves cats';

      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
        dossierContext,
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('## People in this group');
      expect(systemContent).toContain('Alice (+61400000001)');
      expect(systemContent).toContain('Loves cats');
      expect(systemContent).toContain('You are a helpful bot.');
      // Dossier context should appear between time context and system prompt
      const timeIdx = systemContent.indexOf('Current time:');
      const dossierIdx = systemContent.indexOf('## People in this group');
      const promptIdx = systemContent.indexOf('You are a helpful bot.');
      expect(timeIdx).toBeLessThan(dossierIdx);
      expect(dossierIdx).toBeLessThan(promptIdx);
    });

    it('should work without dossier context (backward compatible)', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'You are a helpful bot.' });

      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Current time:');
      expect(systemContent).toContain('You are a helpful bot.');
      expect(systemContent).not.toContain('## People in this group');
    });

    it('should use personaDescription when provided', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
        personaDescription: 'Arr, ye be a pirate!',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Arr, ye be a pirate!');
      expect(systemContent).not.toContain('Default prompt.');
    });

    it('should fall back to systemPrompt when personaDescription is not provided', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Default prompt.');
    });

    it('should include persona safety guidelines in system content', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Persona Guidelines');
      expect(systemContent).toContain('refuse requests');
    });

    it('should resolve sender IDs to display names in history when nameMap provided', () => {
      const builder = new ContextBuilder(defaultConfig);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'uuid-alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'uuid-bob', content: 'Hi there', timestamp: 2000, isBot: false },
      ];
      const nameMap = new Map([
        ['uuid-alice', 'Alice'],
        ['uuid-bob', 'Bob'],
      ]);

      const chatMessages = builder.buildContext({
        history: messages,
        query: 'Query',
        groupId: 'g1',
        sender: 'uuid-alice',
        nameMap,
      });

      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: Hello');
      expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Bob: Hi there');
    });

    it('should fall back to raw sender ID when nameMap has no entry', () => {
      const builder = new ContextBuilder(defaultConfig);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'uuid-unknown', content: 'Hello', timestamp: 1000, isBot: false },
      ];
      const nameMap = new Map([['uuid-alice', 'Alice']]);

      const chatMessages = builder.buildContext({
        history: messages,
        query: 'Query',
        groupId: 'g1',
        sender: 'uuid-unknown',
        nameMap,
      });

      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] uuid-unknown: Hello');
    });

    it('should resolve Current requester to display name when nameMap provided', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });
      const nameMap = new Map([['uuid-zach', 'Zach']]);

      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: 'uuid-zach',
        nameMap,
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Current requester: Zach (uuid-zach)');
    });

    it('should show raw sender in Current requester when no nameMap', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });

      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: 'uuid-zach',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Current requester: uuid-zach');
      expect(systemContent).not.toContain('Current requester: Zach');
    });

    it('should inject collaborative testing prompt when collaborativeTestingMode is true', () => {
      const builder = new ContextBuilder({
        ...defaultConfig,
        systemPrompt: 'Default prompt.',
        collaborativeTestingMode: true,
      });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Collaborative Testing Mode');
      expect(systemContent).toContain('technical, precise, and diagnostic');
      expect(systemContent).toContain('Default prompt.');
    });

    it('should not inject collaborative testing prompt when collaborativeTestingMode is false', () => {
      const builder = new ContextBuilder({
        ...defaultConfig,
        systemPrompt: 'Default prompt.',
        collaborativeTestingMode: false,
      });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).not.toContain('Collaborative Testing Mode');
    });

    it('should not inject collaborative testing prompt by default', () => {
      const builder = new ContextBuilder({ ...defaultConfig, systemPrompt: 'Default prompt.' });
      const chatMessages = builder.buildContext({
        history: [],
        query: 'Hello',
        groupId: 'g1',
        sender: '+61400000001',
      });

      const systemContent = chatMessages[0].content;
      expect(systemContent).not.toContain('Collaborative Testing Mode');
    });
  });

  describe('fitToTokenBudget', () => {
    it('should return all messages when within budget', () => {
      const builder = new ContextBuilder({ ...defaultConfig, contextTokenBudget: 4000 });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Bob', content: 'World', timestamp: 2000, isBot: false },
      ];

      const result = builder.fitToTokenBudget(messages);
      expect(result.messages).toHaveLength(2);
      expect(result.formatted).toHaveLength(2);
    });

    it('should trim oldest messages when over budget', () => {
      // "[1970-01-01 10:00] Alice: First message here" ~= 46 chars = 12 tokens
      // With budget of 15 tokens, only 1 message should fit
      const builder = new ContextBuilder({ ...defaultConfig, contextTokenBudget: 15 });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'First message here', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Bob', content: 'Second message here', timestamp: 2000, isBot: false },
      ];

      const result = builder.fitToTokenBudget(messages);
      // Should keep only the newest message that fits
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sender).toBe('Bob');
      expect(result.formatted).toHaveLength(1);
    });

    it('should handle empty messages', () => {
      const builder = new ContextBuilder(defaultConfig);
      const result = builder.fitToTokenBudget([]);
      expect(result.messages).toHaveLength(0);
      expect(result.formatted).toHaveLength(0);
    });

    it('should return pre-formatted strings matching the returned messages', () => {
      const builder = new ContextBuilder({ ...defaultConfig, contextTokenBudget: 4000 });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Bob', content: 'World', timestamp: 2000, isBot: false },
      ];

      const result = builder.fitToTokenBudget(messages);
      expect(result.formatted[0]).toBe(builder.formatMessageForContext(messages[0]));
      expect(result.formatted[1]).toBe(builder.formatMessageForContext(messages[1]));
    });
  });

  describe('formatMessageForContext', () => {
    it('should format user messages with timestamp and sender', () => {
      const builder = new ContextBuilder(defaultConfig);
      const msg: Message = { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false };

      const result = builder.formatMessageForContext(msg);
      expect(result).toBe('[1970-01-01 10:00] Alice: Hello');
    });

    it('should format bot messages without sender prefix', () => {
      const builder = new ContextBuilder(defaultConfig);
      const msg: Message = { id: 1, groupId: 'g1', sender: 'bot', content: 'Hi there!', timestamp: 1000, isBot: true };

      const result = builder.formatMessageForContext(msg);
      expect(result).toBe('[1970-01-01 10:00] Hi there!');
    });

    it('should resolve sender ID to display name when nameMap provided', () => {
      const builder = new ContextBuilder(defaultConfig);
      const msg: Message = {
        id: 1,
        groupId: 'g1',
        sender: 'uuid-alice',
        content: 'Hello',
        timestamp: 1000,
        isBot: false,
      };
      const nameMap = new Map([['uuid-alice', 'Alice']]);

      const result = builder.formatMessageForContext(msg, nameMap);
      expect(result).toBe('[1970-01-01 10:00] Alice: Hello');
    });

    it('should include voice attachment lines', () => {
      const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
      const msg: Message = {
        id: 1,
        groupId: 'g1',
        sender: 'Alice',
        content: '',
        timestamp: 1000,
        isBot: false,
        attachments: [{ id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null }],
      };

      const result = builder.formatMessageForContext(msg);
      expect(result).toContain('[Voice message attached: /data/attachments/voice-abc]');
    });

    it('should include image attachment lines', () => {
      const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
      const msg: Message = {
        id: 1,
        groupId: 'g1',
        sender: 'Alice',
        content: 'check this',
        timestamp: 1000,
        isBot: false,
        attachments: [{ id: 'img-123', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
      };

      const result = builder.formatMessageForContext(msg);
      expect(result).toContain('[Image: attachment://img-123]');
    });
  });

  describe('formatVoiceAttachment', () => {
    it('should format voice attachment path', () => {
      const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
      const result = builder.formatVoiceAttachment('voice-abc');
      expect(result).toBe('[Voice message attached: /data/attachments/voice-abc]');
    });
  });

  describe('formatImageAttachment', () => {
    it('should format image attachment as attachment:// URI', () => {
      const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
      const result = builder.formatImageAttachment('img-abc');
      expect(result).toBe('[Image: attachment://img-abc]');
    });
  });
});
