#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const PORT = parseInt(process.env.MOCK_SIGNAL_PORT || '9090', 10);
const GROUP_ID = 'kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=';
const SENDER = '+61400111222';

/** Generate a 50x50 gradient PNG at runtime — complex enough for Claude's vision API. */
function generateTestPng(): Buffer {
  const w = 50;
  const h = 50;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const px = row + 1 + x * 4;
      raw[px] = Math.floor((255 * x) / w); // R
      raw[px + 1] = Math.floor((255 * y) / h); // G
      raw[px + 2] = 128 + Math.floor(64 * (((x * 7 + y * 11) % 20) / 20)); // B
      raw[px + 3] = 255; // A
    }
  }
  const idat = zlib.deflateSync(raw);

  function chunk(type: string, data: Buffer): Buffer {
    const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typeData) >>> 0);
    return Buffer.concat([len, typeData, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEST_PNG = generateTestPng();

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
      attachments?: Array<{
        id: string;
        contentType: string;
        size: number;
        filename: string | null;
      }>;
    };
  };
}

const messageQueue: Envelope[] = [];
const attachmentStore = new Map<string, Buffer>();
let isTyping = false;

function createEnvelope(
  text: string,
  attachments?: Array<{ id: string; contentType: string; size: number; filename: string | null }>,
): Envelope {
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
        attachments,
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

function queueImageMessage(text: string): { attachmentId: string } {
  const attachmentId = `mock-img-${Date.now()}`;
  attachmentStore.set(attachmentId, TEST_PNG);
  const attachDir = process.env.ATTACHMENTS_DIR || './data/signal-attachments';
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, attachmentId), TEST_PNG);
  const envelope = createEnvelope(text, [
    { id: attachmentId, contentType: 'image/png', size: TEST_PNG.length, filename: 'test-image.png' },
  ]);
  messageQueue.push(envelope);
  console.log(`${GREEN}[QUEUED]${RESET} image message with attachment ${attachmentId}`);
  return { attachmentId };
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
    return [{ id: GROUP_ID, name: 'Bot Test', isMember: true, members: [SENDER] }];
  },
  getGroup: params => {
    if (params.groupId === GROUP_ID) {
      return { id: GROUP_ID, name: 'Bot Test', members: [SENDER], admins: [], blocked: false };
    }
    throw new Error(`Unknown group: ${params.groupId}`);
  },
  quitGroup: () => ({}),
  joinGroup: () => ({}),
  // Allows queuing messages via HTTP (useful for headless/background testing)
  // Pass { image: true } to attach a test PNG image (same as /image stdin command)
  queueMessage: params => {
    const text = (params.message as string) || '';
    if (!text) return { error: 'message is required' };

    if (params.image) {
      const { attachmentId } = queueImageMessage(text);
      return { queued: true, queueLength: messageQueue.length, attachmentId };
    }

    messageQueue.push(createEnvelope(text));
    console.log(`${GREEN}[QUEUED]${RESET} "${text}"`);
    return { queued: true, queueLength: messageQueue.length };
  },
};

const server = http.createServer((req, res) => {
  // REST endpoint: GET /v1/attachments/{id} — returns base64 JSON like signal-cli
  if (req.method === 'GET' && req.url?.startsWith('/v1/attachments/')) {
    const id = req.url.slice('/v1/attachments/'.length);
    const data = attachmentStore.get(id);
    if (!data) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Attachment not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: data.toString('base64') }));
    return;
  }

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

    try {
      const result = handler((params as Record<string, unknown>) || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result, id }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: (err as Error).message }, id }));
    }
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
  if (cmd === '/image') {
    queueImageMessage('claude: what is this image?');
    rl.prompt();
  } else if (cmd === '/clear') {
    messageQueue.length = 0;
    console.log('Queue cleared.');
  } else if (cmd === '/help') {
    console.log(`${DIM}Commands:${RESET}`);
    console.log(`${DIM}  /image  - Queue a test image message${RESET}`);
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
