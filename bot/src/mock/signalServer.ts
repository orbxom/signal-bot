#!/usr/bin/env node
import http from 'node:http';
import readline from 'node:readline';

const PORT = parseInt(process.env.MOCK_SIGNAL_PORT || '9090', 10);
const GROUP_ID = 'kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=';
const SENDER = '+61400111222';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface Envelope {
  envelope: {
    sourceNumber: string;
    sourceUuid: string;
    timestamp: number;
    dataMessage: {
      timestamp: number;
      message: string;
      groupInfo: { groupId: string };
    };
  };
}

const messageQueue: Envelope[] = [];
let isTyping = false;

function createEnvelope(text: string): Envelope {
  const now = Date.now();
  return {
    envelope: {
      sourceNumber: SENDER,
      sourceUuid: 'mock-uuid-1234',
      timestamp: now,
      dataMessage: {
        timestamp: now,
        message: text,
        groupInfo: { groupId: GROUP_ID },
      },
    },
  };
}

function clearTypingLine() {
  if (isTyping) {
    process.stdout.write(`\r${' '.repeat(40)}\r`);
    isTyping = false;
  }
}

type RpcHandler = (params: Record<string, unknown>) => unknown;

const handlers: Record<string, RpcHandler> = {
  receive: () => {
    const messages = [...messageQueue];
    messageQueue.length = 0;
    return messages;
  },
  send: _params => {
    clearTypingLine();
    const msg = (_params.message as string) || '';
    console.log(`\n${CYAN}[BOT]${RESET} ${msg}`);
    rl.prompt();
    return {};
  },
  sendTyping: params => {
    if (params.stop) {
      clearTypingLine();
    } else {
      process.stdout.write(`\r${YELLOW}[TYPING...]${RESET}`);
      isTyping = true;
    }
    return {};
  },
  listGroups: () => {
    return [{ id: GROUP_ID, name: 'Bot Test', isMember: true }];
  },
  // Allows queuing messages via HTTP (useful for headless/background testing)
  queueMessage: params => {
    const text = (params.message as string) || '';
    if (!text) return { error: 'message is required' };
    messageQueue.push(createEnvelope(text));
    console.log(`${GREEN}[QUEUED]${RESET} "${text}"`);
    return { queued: true, queueLength: messageQueue.length };
  },
};

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/v1/rpc') {
    res.writeHead(404);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    let parsed: { method?: string; params?: Record<string, unknown>; id?: string | number };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const { method, params, id } = parsed;
    const handler = method ? handlers[method] : undefined;

    if (!handler) {
      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown method: ${method}` }, id }));
      return;
    }

    const result = handler((params as Record<string, unknown>) || {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', result, id }));
  });
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'you> ',
});

function handleCommand(line: string) {
  const cmd = line.toLowerCase();
  if (cmd === '/quit' || cmd === '/exit') {
    console.log('Shutting down...');
    server.close();
    rl.close();
    process.exit(0);
  }
  if (cmd === '/clear') {
    messageQueue.length = 0;
    console.log('Queue cleared.');
  } else if (cmd === '/help') {
    console.log(`${DIM}Commands:${RESET}`);
    console.log(`${DIM}  /clear  - Clear message queue${RESET}`);
    console.log(`${DIM}  /quit   - Shut down${RESET}`);
    console.log(`${DIM}  /help   - Show this help${RESET}`);
  } else {
    console.log(`Unknown command: ${line}. Type /help for commands.`);
  }
  rl.prompt();
}

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  if (trimmed.startsWith('/')) {
    handleCommand(trimmed);
    return;
  }
  messageQueue.push(createEnvelope(trimmed));
  const preview = trimmed.length > 60 ? `${trimmed.substring(0, 60)}...` : trimmed;
  console.log(`${GREEN}[QUEUED]${RESET} "${preview}"`);
  rl.prompt();
});

rl.on('close', () => {
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log('=== Mock Signal-CLI Server ===');
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Group: Bot Test`);
  console.log(`Sender: ${SENDER}`);
  console.log(`${DIM}Tip: Start messages with "claude:" to trigger the bot${RESET}`);
  console.log();
  rl.prompt();
});
