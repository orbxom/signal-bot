# Signal Family Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an LLM-powered Signal bot that responds to mentions in family group chat using Azure OpenAI with conversation context.

**Architecture:** TypeScript bot communicates with signal-cli daemon via JSON-RPC, maintains sliding window conversation history in SQLite, and calls Azure OpenAI API for responses. Deployed as Docker containers on Azure.

**Tech Stack:** TypeScript, Node.js 20, signal-cli, Azure OpenAI SDK, SQLite, Docker

---

## Task 1: Project Initialization

**Files:**
- Create: `bot/package.json`
- Create: `bot/tsconfig.json`
- Create: `bot/.gitignore`
- Create: `bot/.env.example`

**Step 1: Create package.json**

```json
{
  "name": "signal-family-bot",
  "version": "1.0.0",
  "description": "LLM-powered Signal bot for family chat",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "keywords": ["signal", "bot", "azure", "openai"],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "@azure/openai": "^2.0.0",
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
*.db
*.db-journal
data/
.DS_Store
```

**Step 4: Create .env.example**

```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_KEY=your-key-here
AZURE_OPENAI_DEPLOYMENT=gpt-4o
BOT_PHONE_NUMBER=+61234567890
MENTION_TRIGGERS=@bot,bot:
CONTEXT_WINDOW_SIZE=20
SIGNAL_CLI_URL=http://signal-cli:8080
DB_PATH=./data/bot.db
```

**Step 5: Install dependencies**

Run: `cd bot && npm install`
Expected: Dependencies installed successfully

**Step 6: Commit**

```bash
git add bot/package.json bot/tsconfig.json bot/.gitignore bot/.env.example
git commit -m "feat: initialize TypeScript project structure"
```

---

## Task 2: Storage Layer - SQLite Database

**Files:**
- Create: `bot/src/storage.ts`
- Create: `bot/src/types.ts`
- Create: `bot/tests/storage.test.ts`

**Step 1: Write types.ts**

```typescript
export interface Message {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: boolean;
}

export interface BotConfig {
  key: string;
  value: string;
}
```

**Step 2: Write failing test for storage initialization**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../src/storage';
import * as fs from 'fs';

describe('Storage', () => {
  const testDbPath = './test.db';

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should initialize database with tables', () => {
    const storage = new Storage(testDbPath);
    expect(storage).toBeDefined();
    storage.close();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test storage.test.ts`
Expected: FAIL - "Cannot find module '../src/storage'"

**Step 4: Write minimal storage.ts implementation**

```typescript
import Database from 'better-sqlite3';
import { Message, BotConfig } from './types';

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_group_timestamp
      ON messages(groupId, timestamp DESC);

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm test storage.test.ts`
Expected: PASS

**Step 6: Write test for adding messages**

```typescript
it('should add and retrieve messages', () => {
  const storage = new Storage(testDbPath);

  storage.addMessage({
    groupId: 'group1',
    sender: 'Alice',
    content: 'Hello',
    timestamp: Date.now(),
    isBot: false
  });

  const messages = storage.getRecentMessages('group1', 10);
  expect(messages).toHaveLength(1);
  expect(messages[0].sender).toBe('Alice');
  expect(messages[0].content).toBe('Hello');

  storage.close();
});
```

**Step 7: Run test to verify it fails**

Run: `npm test storage.test.ts`
Expected: FAIL - "storage.addMessage is not a function"

**Step 8: Implement addMessage and getRecentMessages**

```typescript
// Add to Storage class

addMessage(message: Omit<Message, 'id'>): void {
  const stmt = this.db.prepare(`
    INSERT INTO messages (groupId, sender, content, timestamp, isBot)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    message.groupId,
    message.sender,
    message.content,
    message.timestamp,
    message.isBot ? 1 : 0
  );
}

getRecentMessages(groupId: string, limit: number): Message[] {
  const stmt = this.db.prepare(`
    SELECT * FROM messages
    WHERE groupId = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(groupId, limit) as any[];
  return rows.reverse().map(row => ({
    id: row.id,
    groupId: row.groupId,
    sender: row.sender,
    content: row.content,
    timestamp: row.timestamp,
    isBot: row.isBot === 1
  }));
}
```

**Step 9: Run test to verify it passes**

Run: `npm test storage.test.ts`
Expected: PASS

**Step 10: Write test for trimming old messages**

```typescript
it('should trim old messages beyond window size', () => {
  const storage = new Storage(testDbPath);
  const groupId = 'group1';

  // Add 25 messages
  for (let i = 0; i < 25; i++) {
    storage.addMessage({
      groupId,
      sender: 'User',
      content: `Message ${i}`,
      timestamp: Date.now() + i,
      isBot: false
    });
  }

  storage.trimMessages(groupId, 20);
  const messages = storage.getRecentMessages(groupId, 100);
  expect(messages).toHaveLength(20);
  expect(messages[0].content).toBe('Message 5');

  storage.close();
});
```

**Step 11: Run test to verify it fails**

Run: `npm test storage.test.ts`
Expected: FAIL - "storage.trimMessages is not a function"

**Step 12: Implement trimMessages**

```typescript
// Add to Storage class

trimMessages(groupId: string, keepCount: number): void {
  this.db.prepare(`
    DELETE FROM messages
    WHERE groupId = ?
    AND id NOT IN (
      SELECT id FROM messages
      WHERE groupId = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
  `).run(groupId, groupId, keepCount);
}
```

**Step 13: Run test to verify it passes**

Run: `npm test storage.test.ts`
Expected: PASS

**Step 14: Commit**

```bash
git add bot/src/storage.ts bot/src/types.ts bot/tests/storage.test.ts
git commit -m "feat: implement SQLite storage layer with message history"
```

---

## Task 3: Configuration Management

**Files:**
- Create: `bot/src/config.ts`
- Create: `bot/tests/config.test.ts`

**Step 1: Write failing test for config loading**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Config } from '../src/config';

describe('Config', () => {
  it('should load configuration from environment', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.MENTION_TRIGGERS = '@bot,bot:';
    process.env.CONTEXT_WINDOW_SIZE = '20';

    const config = Config.load();
    expect(config.azureOpenAI.endpoint).toBe('https://test.openai.azure.com/');
    expect(config.azureOpenAI.key).toBe('test-key');
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
    expect(config.contextWindowSize).toBe(20);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test config.test.ts`
Expected: FAIL - "Cannot find module '../src/config'"

**Step 3: Implement config.ts**

```typescript
import { config as loadEnv } from 'dotenv';

loadEnv();

export interface ConfigType {
  azureOpenAI: {
    endpoint: string;
    key: string;
    deployment: string;
  };
  botPhoneNumber: string;
  mentionTriggers: string[];
  contextWindowSize: number;
  signalCliUrl: string;
  dbPath: string;
}

export class Config {
  static load(): ConfigType {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const key = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!endpoint || !key || !deployment) {
      throw new Error('Missing required Azure OpenAI configuration');
    }

    return {
      azureOpenAI: {
        endpoint,
        key,
        deployment
      },
      botPhoneNumber: process.env.BOT_PHONE_NUMBER || '',
      mentionTriggers: (process.env.MENTION_TRIGGERS || '@bot').split(','),
      contextWindowSize: parseInt(process.env.CONTEXT_WINDOW_SIZE || '20', 10),
      signalCliUrl: process.env.SIGNAL_CLI_URL || 'http://localhost:8080',
      dbPath: process.env.DB_PATH || './data/bot.db'
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/config.ts bot/tests/config.test.ts
git commit -m "feat: implement configuration management"
```

---

## Task 4: Azure OpenAI Client

**Files:**
- Create: `bot/src/azureOpenAI.ts`
- Create: `bot/tests/azureOpenAI.test.ts`

**Step 1: Write types for LLM interaction**

Add to `bot/src/types.ts`:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
}
```

**Step 2: Write failing test for Azure client**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { AzureOpenAIClient } from '../src/azureOpenAI';
import type { ChatMessage } from '../src/types';

describe('AzureOpenAIClient', () => {
  it('should format conversation history correctly', () => {
    const client = new AzureOpenAIClient(
      'https://test.openai.azure.com/',
      'test-key',
      'gpt-4o'
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ];

    const formatted = client.formatMessages(messages);
    expect(formatted).toHaveLength(4);
    expect(formatted[0].role).toBe('system');
    expect(formatted[3].role).toBe('user');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test azureOpenAI.test.ts`
Expected: FAIL - "Cannot find module '../src/azureOpenAI'"

**Step 4: Implement Azure OpenAI client**

```typescript
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';
import type { ChatMessage, LLMResponse } from './types';

export class AzureOpenAIClient {
  private client: OpenAIClient;
  private deployment: string;

  constructor(endpoint: string, key: string, deployment: string) {
    this.client = new OpenAIClient(endpoint, new AzureKeyCredential(key));
    this.deployment = deployment;
  }

  formatMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  async generateResponse(messages: ChatMessage[]): Promise<LLMResponse> {
    try {
      const result = await this.client.getChatCompletions(
        this.deployment,
        messages.map(m => ({ role: m.role, content: m.content })),
        {
          temperature: 0.7,
          maxTokens: 500
        }
      );

      const choice = result.choices[0];
      if (!choice?.message?.content) {
        throw new Error('No response from Azure OpenAI');
      }

      return {
        content: choice.message.content,
        tokensUsed: result.usage?.totalTokens || 0
      };
    } catch (error) {
      console.error('Azure OpenAI error:', error);
      throw new Error('Failed to generate response from LLM');
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm test azureOpenAI.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add bot/src/azureOpenAI.ts bot/src/types.ts bot/tests/azureOpenAI.test.ts
git commit -m "feat: implement Azure OpenAI client"
```

---

## Task 5: Signal CLI Client Wrapper

**Files:**
- Create: `bot/src/signalClient.ts`
- Create: `bot/tests/signalClient.test.ts`

**Step 1: Add Signal types to types.ts**

```typescript
export interface SignalMessage {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceUuid?: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message?: string;
      groupInfo?: {
        groupId: string;
      };
    };
  };
}

export interface SignalSendRequest {
  recipient?: string;
  groupId?: string;
  message: string;
}
```

**Step 2: Write failing test for message sending**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SignalClient } from '../src/signalClient';

describe('SignalClient', () => {
  it('should construct send message request', () => {
    const client = new SignalClient('http://localhost:8080', '+1234567890');

    const request = client.buildSendRequest('group123', 'Hello world');
    expect(request.groupId).toBe('group123');
    expect(request.message).toBe('Hello world');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test signalClient.test.ts`
Expected: FAIL - "Cannot find module '../src/signalClient'"

**Step 4: Implement Signal client**

```typescript
import type { SignalMessage, SignalSendRequest } from './types';

export class SignalClient {
  private baseUrl: string;
  private account: string;

  constructor(baseUrl: string, account: string) {
    this.baseUrl = baseUrl;
    this.account = account;
  }

  buildSendRequest(groupId: string, message: string): SignalSendRequest {
    return {
      groupId,
      message
    };
  }

  async sendMessage(groupId: string, message: string): Promise<void> {
    const payload = {
      jsonrpc: '2.0',
      method: 'send',
      params: {
        account: this.account,
        groupId,
        message
      },
      id: Date.now()
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Signal API error: ${response.statusText}`);
      }

      const result = await response.json();
      if (result.error) {
        throw new Error(`Signal RPC error: ${result.error.message}`);
      }
    } catch (error) {
      console.error('Failed to send Signal message:', error);
      throw error;
    }
  }

  extractMessageData(signalMsg: SignalMessage): {
    sender: string;
    content: string;
    groupId: string;
    timestamp: number;
  } | null {
    const envelope = signalMsg.envelope;
    const dataMessage = envelope.dataMessage;

    if (!dataMessage?.message || !dataMessage.groupInfo?.groupId) {
      return null;
    }

    return {
      sender: envelope.sourceNumber || envelope.source || 'unknown',
      content: dataMessage.message,
      groupId: dataMessage.groupInfo.groupId,
      timestamp: envelope.timestamp
    };
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm test signalClient.test.ts`
Expected: PASS

**Step 6: Write test for message extraction**

```typescript
it('should extract message data from Signal envelope', () => {
  const client = new SignalClient('http://localhost:8080', '+1234567890');

  const signalMsg: SignalMessage = {
    envelope: {
      sourceNumber: '+9876543210',
      timestamp: 1234567890,
      dataMessage: {
        timestamp: 1234567890,
        message: 'Test message',
        groupInfo: {
          groupId: 'abc123'
        }
      }
    }
  };

  const extracted = client.extractMessageData(signalMsg);
  expect(extracted).not.toBeNull();
  expect(extracted!.sender).toBe('+9876543210');
  expect(extracted!.content).toBe('Test message');
  expect(extracted!.groupId).toBe('abc123');
});
```

**Step 7: Run test to verify it passes**

Run: `npm test signalClient.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add bot/src/signalClient.ts bot/src/types.ts bot/tests/signalClient.test.ts
git commit -m "feat: implement Signal CLI client wrapper"
```

---

## Task 6: Message Handler - Core Logic

**Files:**
- Create: `bot/src/messageHandler.ts`
- Create: `bot/tests/messageHandler.test.ts`

**Step 1: Write failing test for mention detection**

```typescript
import { describe, it, expect } from 'vitest';
import { MessageHandler } from '../src/messageHandler';

describe('MessageHandler', () => {
  it('should detect bot mentions', () => {
    const handler = new MessageHandler(['@bot', 'bot:']);

    expect(handler.isMentioned('@bot hello')).toBe(true);
    expect(handler.isMentioned('bot: what time is it?')).toBe(true);
    expect(handler.isMentioned('hello everyone')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test messageHandler.test.ts`
Expected: FAIL - "Cannot find module '../src/messageHandler'"

**Step 3: Implement mention detection**

```typescript
import type { Message, ChatMessage } from './types';
import type { Storage } from './storage';
import type { AzureOpenAIClient } from './azureOpenAI';
import type { SignalClient } from './signalClient';

export class MessageHandler {
  private mentionTriggers: string[];
  private storage?: Storage;
  private llmClient?: AzureOpenAIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;

  constructor(
    mentionTriggers: string[],
    storage?: Storage,
    llmClient?: AzureOpenAIClient,
    signalClient?: SignalClient,
    contextWindowSize: number = 20
  ) {
    this.mentionTriggers = mentionTriggers;
    this.storage = storage;
    this.llmClient = llmClient;
    this.signalClient = signalClient;
    this.contextWindowSize = contextWindowSize;
  }

  isMentioned(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return this.mentionTriggers.some(trigger =>
      lowerContent.includes(trigger.toLowerCase())
    );
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test messageHandler.test.ts`
Expected: PASS

**Step 5: Write test for extracting query from mention**

```typescript
it('should extract query from mentioned message', () => {
  const handler = new MessageHandler(['@bot', 'bot:']);

  expect(handler.extractQuery('@bot what is the weather?'))
    .toBe('what is the weather?');
  expect(handler.extractQuery('bot: tell me a joke'))
    .toBe('tell me a joke');
  expect(handler.extractQuery('hey @bot how are you'))
    .toBe('hey how are you');
});
```

**Step 6: Run test to verify it fails**

Run: `npm test messageHandler.test.ts`
Expected: FAIL - "handler.extractQuery is not a function"

**Step 7: Implement extractQuery**

```typescript
// Add to MessageHandler class

extractQuery(content: string): string {
  let query = content;
  for (const trigger of this.mentionTriggers) {
    query = query.replace(new RegExp(trigger, 'gi'), '');
  }
  return query.trim();
}
```

**Step 8: Run test to verify it passes**

Run: `npm test messageHandler.test.ts`
Expected: PASS

**Step 9: Write test for building conversation context**

```typescript
it('should build conversation context from history', () => {
  const handler = new MessageHandler(['@bot']);

  const messages: Message[] = [
    { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
    { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi Alice!', timestamp: 2000, isBot: true },
    { id: 3, groupId: 'g1', sender: 'Bob', content: 'How are you?', timestamp: 3000, isBot: false }
  ];

  const chatMessages = handler.buildContext(messages, 'What time is it?');

  expect(chatMessages[0].role).toBe('system');
  expect(chatMessages[1].role).toBe('user');
  expect(chatMessages[1].content).toContain('Alice: Hello');
  expect(chatMessages[2].role).toBe('assistant');
  expect(chatMessages[2].content).toBe('Hi Alice!');
  expect(chatMessages[3].role).toBe('user');
  expect(chatMessages[3].content).toContain('Bob: How are you?');
  expect(chatMessages[4].role).toBe('user');
  expect(chatMessages[4].content).toContain('What time is it?');
});
```

**Step 10: Run test to verify it fails**

Run: `npm test messageHandler.test.ts`
Expected: FAIL - "handler.buildContext is not a function"

**Step 11: Implement buildContext**

```typescript
// Add to MessageHandler class

buildContext(history: Message[], currentQuery: string): ChatMessage[] {
  const systemPrompt: ChatMessage = {
    role: 'system',
    content: 'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful.'
  };

  const contextMessages: ChatMessage[] = [systemPrompt];

  for (const msg of history) {
    if (msg.isBot) {
      contextMessages.push({
        role: 'assistant',
        content: msg.content
      });
    } else {
      contextMessages.push({
        role: 'user',
        content: `${msg.sender}: ${msg.content}`
      });
    }
  }

  contextMessages.push({
    role: 'user',
    content: currentQuery
  });

  return contextMessages;
}
```

**Step 12: Run test to verify it passes**

Run: `npm test messageHandler.test.ts`
Expected: PASS

**Step 13: Implement main handleMessage method**

```typescript
// Add to MessageHandler class

async handleMessage(
  groupId: string,
  sender: string,
  content: string,
  timestamp: number
): Promise<void> {
  if (!this.storage || !this.llmClient || !this.signalClient) {
    throw new Error('Handler not fully initialized');
  }

  // Store incoming message
  this.storage.addMessage({
    groupId,
    sender,
    content,
    timestamp,
    isBot: false
  });

  // Check for mention
  if (!this.isMentioned(content)) {
    return;
  }

  try {
    // Extract query
    const query = this.extractQuery(content);

    // Get conversation history
    const history = this.storage.getRecentMessages(groupId, this.contextWindowSize - 1);

    // Build context
    const messages = this.buildContext(history, query);

    // Get LLM response
    const response = await this.llmClient.generateResponse(messages);

    // Send response
    await this.signalClient.sendMessage(groupId, response.content);

    // Store bot response
    this.storage.addMessage({
      groupId,
      sender: 'bot',
      content: response.content,
      timestamp: Date.now(),
      isBot: true
    });

    // Trim old messages
    this.storage.trimMessages(groupId, this.contextWindowSize);

    console.log(`[${groupId}] Responded to ${sender} (${response.tokensUsed} tokens)`);
  } catch (error) {
    console.error('Error handling message:', error);

    // Send error message to group
    const errorMsg = 'Sorry, I encountered an error processing your request.';
    await this.signalClient.sendMessage(groupId, errorMsg);
  }
}
```

**Step 14: Commit**

```bash
git add bot/src/messageHandler.ts bot/tests/messageHandler.test.ts
git commit -m "feat: implement message handler with mention detection and context building"
```

---

## Task 7: Main Application Entry Point

**Files:**
- Create: `bot/src/index.ts`
- Modify: `bot/src/signalClient.ts` (add polling/webhook support)

**Step 1: Implement message polling in SignalClient**

Add to `bot/src/signalClient.ts`:

```typescript
// Add to SignalClient class

async receiveMessages(): Promise<SignalMessage[]> {
  const payload = {
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: this.account
    },
    id: Date.now()
  };

  try {
    const response = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Signal API error: ${response.statusText}`);
    }

    const result = await response.json();
    return result.result || [];
  } catch (error) {
    console.error('Failed to receive messages:', error);
    return [];
  }
}
```

**Step 2: Write main application entry point**

```typescript
import { Config } from './config';
import { Storage } from './storage';
import { AzureOpenAIClient } from './azureOpenAI';
import { SignalClient } from './signalClient';
import { MessageHandler } from './messageHandler';

async function main() {
  console.log('Starting Signal Family Bot...');

  // Load configuration
  const config = Config.load();
  console.log('Configuration loaded');

  // Initialize storage
  const storage = new Storage(config.dbPath);
  console.log(`Database initialized at ${config.dbPath}`);

  // Initialize Azure OpenAI client
  const llmClient = new AzureOpenAIClient(
    config.azureOpenAI.endpoint,
    config.azureOpenAI.key,
    config.azureOpenAI.deployment
  );
  console.log('Azure OpenAI client initialized');

  // Initialize Signal client
  const signalClient = new SignalClient(
    config.signalCliUrl,
    config.botPhoneNumber
  );
  console.log('Signal client initialized');

  // Initialize message handler
  const messageHandler = new MessageHandler(
    config.mentionTriggers,
    storage,
    llmClient,
    signalClient,
    config.contextWindowSize
  );
  console.log(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  // Start polling loop
  console.log('Starting message polling...');
  while (true) {
    try {
      const messages = await signalClient.receiveMessages();

      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);

        if (data) {
          console.log(`[${data.groupId}] ${data.sender}: ${data.content.substring(0, 50)}...`);
          await messageHandler.handleMessage(
            data.groupId,
            data.sender,
            data.content,
            data.timestamp
          );
        }
      }
    } catch (error) {
      console.error('Error in polling loop:', error);
    }

    // Poll every 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

// Start the bot
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

**Step 3: Test build**

Run: `npm run build`
Expected: TypeScript compiles successfully to dist/

**Step 4: Commit**

```bash
git add bot/src/index.ts bot/src/signalClient.ts
git commit -m "feat: implement main application entry point with polling loop"
```

---

## Task 8: Docker Setup

**Files:**
- Create: `bot/Dockerfile`
- Create: `signal-cli/Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Step 1: Create bot Dockerfile**

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY bot/package*.json ./
RUN npm ci --only=production

# Copy source
COPY bot/tsconfig.json ./
COPY bot/src ./src

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /app/data

# Run the bot
CMD ["node", "dist/index.js"]
```

**Step 2: Create signal-cli Dockerfile**

```dockerfile
FROM alpine:latest

# Install dependencies
RUN apk add --no-cache \
    openjdk17-jre \
    libzkfp \
    curl

# Download and install signal-cli
ARG SIGNAL_CLI_VERSION=0.13.1
RUN curl -L "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz" \
    | tar xz -C /opt

ENV PATH="/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin:${PATH}"

# Create data directory
RUN mkdir -p /var/lib/signal-cli

# Expose JSON-RPC port
EXPOSE 8080

# Run signal-cli daemon
CMD ["signal-cli", "-a", "${BOT_PHONE_NUMBER}", "daemon", "--http", "0.0.0.0:8080"]
```

**Step 3: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  signal-cli:
    build:
      context: .
      dockerfile: signal-cli/Dockerfile
    container_name: signal-cli
    environment:
      - BOT_PHONE_NUMBER=${BOT_PHONE_NUMBER}
    volumes:
      - ./data/signal-cli-config:/var/lib/signal-cli
    ports:
      - "8080:8080"
    restart: unless-stopped
    networks:
      - bot-network

  bot:
    build:
      context: .
      dockerfile: bot/Dockerfile
    container_name: signal-family-bot
    depends_on:
      - signal-cli
    environment:
      - AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT}
      - AZURE_OPENAI_KEY=${AZURE_OPENAI_KEY}
      - AZURE_OPENAI_DEPLOYMENT=${AZURE_OPENAI_DEPLOYMENT}
      - BOT_PHONE_NUMBER=${BOT_PHONE_NUMBER}
      - MENTION_TRIGGERS=${MENTION_TRIGGERS}
      - CONTEXT_WINDOW_SIZE=${CONTEXT_WINDOW_SIZE}
      - SIGNAL_CLI_URL=http://signal-cli:8080
      - DB_PATH=/app/data/bot.db
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    networks:
      - bot-network

networks:
  bot-network:
    driver: bridge

volumes:
  signal-cli-data:
  bot-data:
```

**Step 4: Create .dockerignore**

```
node_modules
dist
*.log
.env
.env.local
*.db
.git
.gitignore
docs
tests
*.test.ts
```

**Step 5: Create data directories**

Run: `mkdir -p data/signal-cli-config`
Expected: Directories created

**Step 6: Commit**

```bash
git add bot/Dockerfile signal-cli/Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: add Docker setup for bot and signal-cli"
```

---

## Task 9: Documentation

**Files:**
- Create: `README.md`
- Create: `docs/setup.md`
- Create: `docs/deployment.md`

**Step 1: Create README.md**

```markdown
# Signal Family Bot

LLM-powered Signal bot for family group chat using Azure OpenAI.

## Features

- Responds to mentions (@bot or bot:)
- Maintains conversation context (sliding window)
- Powered by Azure OpenAI
- Docker-based deployment
- SQLite storage for message history

## Quick Start

1. Copy `.env.example` to `.env` and configure:
   ```bash
   cp bot/.env.example .env
   ```

2. Build and start containers:
   ```bash
   docker-compose up --build
   ```

3. Register Signal number (first time only):
   ```bash
   docker exec -it signal-cli signal-cli -a +61YOURPHONE register
   # Verify with SMS code
   docker exec -it signal-cli signal-cli -a +61YOURPHONE verify CODE
   ```

4. Add bot to your Signal group and test with `@bot hello`

## Documentation

- [Setup Guide](docs/setup.md) - Detailed setup instructions
- [Deployment](docs/deployment.md) - Azure deployment guide
- [Design](docs/plans/2025-12-20-signal-family-bot-design.md) - Architecture design

## Configuration

See `bot/.env.example` for all configuration options.

## Development

```bash
cd bot
npm install
npm run dev
```

## License

MIT
```

**Step 2: Create docs/setup.md**

```markdown
# Setup Guide

## Prerequisites

- Docker and Docker Compose
- Azure OpenAI account with API access
- Phone number for bot (Australian number in your case)
- Signal account to add bot to group

## Initial Setup

### 1. Clone and Configure

```bash
cd signal-bot
cp bot/.env.example .env
```

Edit `.env` with your values:
- Azure OpenAI endpoint and key
- Bot phone number (+61...)
- Deployment name (gpt-4o or gpt-3.5-turbo)

### 2. Build Containers

```bash
docker-compose build
```

### 3. Start signal-cli

```bash
docker-compose up -d signal-cli
```

### 4. Register Signal Number

```bash
# Request verification code
docker exec -it signal-cli signal-cli -a +61YOURPHONE register

# Verify with SMS code
docker exec -it signal-cli signal-cli -a +61YOURPHONE verify XXXXXX
```

### 5. Start Bot

```bash
docker-compose up -d bot
```

### 6. Add to Group

From your main Signal account:
1. Create or open your family group
2. Add the bot's phone number (+61...)
3. Test with: `@bot hello`

## Monitoring

View logs:
```bash
docker-compose logs -f bot
```

Check signal-cli:
```bash
docker-compose logs -f signal-cli
```

## Troubleshooting

**Bot doesn't respond:**
- Check logs: `docker-compose logs bot`
- Verify signal-cli is running: `docker-compose ps`
- Test Signal connection: `docker exec -it signal-cli signal-cli -a +61... listGroups`

**Azure OpenAI errors:**
- Verify credentials in `.env`
- Check deployment name matches Azure
- Monitor Azure OpenAI quota/limits

**Database issues:**
- Database at `./data/bot.db`
- Inspect: `sqlite3 ./data/bot.db "SELECT * FROM messages;"`
```

**Step 3: Create docs/deployment.md**

```markdown
# Azure Deployment Guide

## Overview

Deploy Signal bot to Azure Container Instances using Azure Container Registry.

## Prerequisites

- Azure account with credits
- Azure CLI installed
- Docker installed locally

## Steps

### 1. Create Azure Container Registry

```bash
az login

az group create --name signal-bot-rg --location eastus

az acr create --resource-group signal-bot-rg \
  --name signalbotacr --sku Basic
```

### 2. Build and Push Images

```bash
# Login to ACR
az acr login --name signalbotacr

# Tag and push signal-cli
docker tag signal-bot_signal-cli signalbotacr.azurecr.io/signal-cli:latest
docker push signalbotacr.azurecr.io/signal-cli:latest

# Tag and push bot
docker tag signal-bot_bot signalbotacr.azurecr.io/bot:latest
docker push signalbotacr.azurecr.io/bot:latest
```

### 3. Create Azure File Share

```bash
az storage account create \
  --resource-group signal-bot-rg \
  --name signalbotstore \
  --sku Standard_LRS

az storage share create \
  --name bot-data \
  --account-name signalbotstore
```

### 4. Create Key Vault for Secrets

```bash
az keyvault create \
  --resource-group signal-bot-rg \
  --name signal-bot-kv

az keyvault secret set \
  --vault-name signal-bot-kv \
  --name azure-openai-key \
  --value "YOUR_KEY"
```

### 5. Deploy Container Group

Create `azure-deploy.yaml`:

```yaml
apiVersion: 2021-09-01
location: eastus
name: signal-bot-group
properties:
  containers:
  - name: signal-cli
    properties:
      image: signalbotacr.azurecr.io/signal-cli:latest
      resources:
        requests:
          cpu: 0.5
          memoryInGb: 1
      ports:
      - port: 8080
      environmentVariables:
      - name: BOT_PHONE_NUMBER
        value: "+61YOURPHONE"
      volumeMounts:
      - name: signal-data
        mountPath: /var/lib/signal-cli

  - name: bot
    properties:
      image: signalbotacr.azurecr.io/bot:latest
      resources:
        requests:
          cpu: 0.5
          memoryInGb: 0.5
      environmentVariables:
      - name: AZURE_OPENAI_ENDPOINT
        value: "https://your-resource.openai.azure.com/"
      - name: AZURE_OPENAI_KEY
        secureValue: "YOUR_KEY"
      - name: AZURE_OPENAI_DEPLOYMENT
        value: "gpt-4o"
      - name: BOT_PHONE_NUMBER
        value: "+61YOURPHONE"
      - name: SIGNAL_CLI_URL
        value: "http://localhost:8080"
      volumeMounts:
      - name: bot-data
        mountPath: /app/data

  volumes:
  - name: signal-data
    azureFile:
      shareName: bot-data
      storageAccountName: signalbotstore
      storageAccountKey: "KEY"
  - name: bot-data
    azureFile:
      shareName: bot-data
      storageAccountName: signalbotstore
      storageAccountKey: "KEY"

  imageRegistryCredentials:
  - server: signalbotacr.azurecr.io
    username: signalbotacr
    password: "ACR_PASSWORD"

  osType: Linux
  restartPolicy: Always
tags: null
type: Microsoft.ContainerInstance/containerGroups
```

Deploy:

```bash
az container create --resource-group signal-bot-rg \
  --file azure-deploy.yaml
```

### 6. Monitor

```bash
# View logs
az container logs --resource-group signal-bot-rg \
  --name signal-bot-group --container-name bot

# Check status
az container show --resource-group signal-bot-rg \
  --name signal-bot-group
```

## Cost Monitoring

```bash
az consumption usage list --resource-group signal-bot-rg
```

## Cleanup

```bash
az group delete --name signal-bot-rg
```
```

**Step 4: Commit**

```bash
git add README.md docs/setup.md docs/deployment.md
git commit -m "docs: add comprehensive setup and deployment documentation"
```

---

## Task 10: Testing and Validation

**Files:**
- Create: `bot/tests/integration.test.ts`
- Modify: `bot/package.json` (add test script)

**Step 1: Add test:integration script to package.json**

```json
{
  "scripts": {
    "test": "vitest",
    "test:integration": "vitest run tests/integration.test.ts"
  }
}
```

**Step 2: Write integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Storage } from '../src/storage';
import { MessageHandler } from '../src/messageHandler';
import * as fs from 'fs';

describe('Integration Tests', () => {
  const testDbPath = './integration-test.db';
  let storage: Storage;

  beforeAll(() => {
    storage = new Storage(testDbPath);
  });

  afterAll(() => {
    storage.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should handle full message flow with storage', () => {
    const handler = new MessageHandler(
      ['@bot'],
      storage,
      undefined,
      undefined,
      20
    );

    const groupId = 'test-group';

    // Add some conversation history
    storage.addMessage({
      groupId,
      sender: 'Alice',
      content: 'Hello everyone',
      timestamp: Date.now() - 3000,
      isBot: false
    });

    storage.addMessage({
      groupId,
      sender: 'Bob',
      content: '@bot what is 2+2?',
      timestamp: Date.now() - 2000,
      isBot: false
    });

    // Verify mention detection
    expect(handler.isMentioned('@bot what is 2+2?')).toBe(true);

    // Verify query extraction
    const query = handler.extractQuery('@bot what is 2+2?');
    expect(query).toBe('what is 2+2?');

    // Verify context building
    const history = storage.getRecentMessages(groupId, 10);
    const context = handler.buildContext(history, query);

    expect(context[0].role).toBe('system');
    expect(context.length).toBeGreaterThan(1);
  });

  it('should maintain sliding window of messages', () => {
    const groupId = 'window-test';

    // Add 25 messages
    for (let i = 0; i < 25; i++) {
      storage.addMessage({
        groupId,
        sender: `User${i}`,
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        isBot: i % 3 === 0
      });
    }

    // Trim to 20
    storage.trimMessages(groupId, 20);

    // Verify only 20 remain
    const messages = storage.getRecentMessages(groupId, 100);
    expect(messages).toHaveLength(20);
    expect(messages[0].content).toBe('Message 5');
    expect(messages[19].content).toBe('Message 24');
  });
});
```

**Step 3: Run integration tests**

Run: `npm run test:integration`
Expected: All tests PASS

**Step 4: Run all tests**

Run: `npm test`
Expected: All unit and integration tests PASS

**Step 5: Commit**

```bash
git add bot/tests/integration.test.ts bot/package.json
git commit -m "test: add integration tests for message flow and storage"
```

---

## Post-Implementation Checklist

After completing all tasks:

- [ ] Run full test suite: `npm test`
- [ ] Build Docker images: `docker-compose build`
- [ ] Start locally: `docker-compose up`
- [ ] Register Signal number
- [ ] Test bot responds to @bot mentions
- [ ] Verify conversation context works
- [ ] Check logs for errors
- [ ] Review code for security issues
- [ ] Update documentation with any changes
- [ ] Tag release: `git tag v1.0.0`
- [ ] Deploy to Azure (follow docs/deployment.md)

## Future Enhancements

Consider adding after MVP is working:

- Voice message transcription (Azure Speech)
- Image analysis (Azure Computer Vision)
- Scheduled messages (cron jobs)
- Admin commands (/status, /reload)
- Multi-group support
- Prometheus metrics
- Rate limiting per user
- Better error recovery
