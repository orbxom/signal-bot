# Voice Message Transcription Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the signal bot to transcribe voice messages using whisper-rs and respond to them via an MCP tool.

**Architecture:** Four layers of changes — (1) extend TS types and signal client to surface voice attachments, (2) update message handler and Claude client to pass attachment info to Claude, (3) build a Rust MCP server that transcribes audio using whisper-rs with CUDA, (4) wire everything together via Docker volumes and MCP config.

**Tech Stack:** TypeScript (bot), Rust (transcription MCP server), whisper-rs 0.15 + CUDA, symphonia (audio decoding), rubato (resampling), vitest (TS tests), cargo test (Rust tests)

---

### Task 1: Extend SignalMessage type with attachments

**Files:**
- Modify: `bot/src/types.ts:53-67`
- Test: `bot/tests/signalClient.test.ts`

**Step 1: Write failing tests for attachment extraction**

Add these tests to `bot/tests/signalClient.test.ts` inside the `extractMessageData` describe block:

```typescript
it('should extract attachment metadata from Signal envelope', () => {
  const client = new SignalClient('http://localhost:8080', '+1234567890');

  const signalMsg: SignalMessage = {
    envelope: {
      sourceNumber: '+9876543210',
      timestamp: 1234567890,
      dataMessage: {
        timestamp: 1234567890,
        message: 'claude: check this',
        groupInfo: { groupId: 'abc123' },
        attachments: [
          {
            id: 'attachment-abc',
            contentType: 'audio/aac',
            size: 12345,
            filename: null,
          },
        ],
      },
    },
  };

  const extracted = client.extractMessageData(signalMsg);
  expect(extracted).not.toBeNull();
  expect(extracted?.attachments).toHaveLength(1);
  expect(extracted?.attachments?.[0].id).toBe('attachment-abc');
  expect(extracted?.attachments?.[0].contentType).toBe('audio/aac');
});

it('should return message data with empty attachments array when none present', () => {
  const client = new SignalClient('http://localhost:8080', '+1234567890');

  const signalMsg: SignalMessage = {
    envelope: {
      sourceNumber: '+9876543210',
      timestamp: 1234567890,
      dataMessage: {
        timestamp: 1234567890,
        message: 'Hello',
        groupInfo: { groupId: 'abc123' },
      },
    },
  };

  const extracted = client.extractMessageData(signalMsg);
  expect(extracted).not.toBeNull();
  expect(extracted?.attachments).toEqual([]);
});

it('should extract data from voice-only messages with no text', () => {
  const client = new SignalClient('http://localhost:8080', '+1234567890');

  const signalMsg: SignalMessage = {
    envelope: {
      sourceNumber: '+9876543210',
      timestamp: 1234567890,
      dataMessage: {
        timestamp: 1234567890,
        groupInfo: { groupId: 'abc123' },
        attachments: [
          {
            id: 'voice-123',
            contentType: 'audio/aac',
            size: 5000,
            filename: null,
          },
        ],
      },
    },
  };

  const extracted = client.extractMessageData(signalMsg);
  expect(extracted).not.toBeNull();
  expect(extracted?.content).toBe('');
  expect(extracted?.attachments).toHaveLength(1);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: FAIL — `attachments` property doesn't exist on types or return value

**Step 3: Update types.ts to add attachment types**

In `bot/src/types.ts`, add the `SignalAttachment` interface and update `SignalMessage`:

```typescript
export interface SignalAttachment {
  id: string;
  contentType: string;
  size: number;
  filename: string | null;
}
```

Update the `SignalMessage` interface's `dataMessage` to include:
```typescript
attachments?: SignalAttachment[];
```

**Step 4: Update signalClient.ts extractMessageData**

Change `bot/src/signalClient.ts:87-106`. The current logic requires `dataMessage.message` (text) to be truthy. Change it to allow messages through if they have attachments OR text, plus a groupId:

```typescript
extractMessageData(signalMsg: SignalMessage): {
  sender: string;
  content: string;
  groupId: string;
  timestamp: number;
  attachments: SignalAttachment[];
} | null {
  const envelope = signalMsg.envelope;
  const dataMessage = envelope.dataMessage;
  const attachments = dataMessage?.attachments ?? [];
  const hasContent = !!dataMessage?.message;
  const hasAttachments = attachments.length > 0;

  if ((!hasContent && !hasAttachments) || !dataMessage?.groupInfo?.groupId) {
    return null;
  }

  return {
    sender: envelope.sourceNumber || envelope.source || 'unknown',
    content: dataMessage.message ?? '',
    groupId: dataMessage.groupInfo.groupId,
    timestamp: envelope.timestamp,
    attachments,
  };
}
```

Import `SignalAttachment` from `./types`.

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: PASS

Note: The existing test `should return null when message is empty string` (line 156) will now need updating — an empty string with no attachments should still return null, but the check is `!!''` which is false, so it should still return null. However, `should return null when message is missing` (line 118) needs checking — a message with no text AND no attachments should still return null. Verify both still pass. If `should return null when message is empty string` fails because empty string is now allowed, update the test expectation.

**Step 6: Update existing tests for the new `attachments` field**

Existing `extractMessageData` tests that check `extracted?.sender` etc. will now also need to account for the new `attachments` field in the return value. Add `expect(extracted?.attachments).toEqual([])` to existing positive-case tests to verify backward compatibility.

**Step 7: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 8: Commit**

```bash
git add bot/src/types.ts bot/src/signalClient.ts bot/tests/signalClient.test.ts
git commit -m "feat: extend SignalMessage types with attachment support"
```

---

### Task 2: Update message handler to surface voice attachments to Claude

**Files:**
- Modify: `bot/src/messageHandler.ts:86-101, 103-168, 170-297`
- Modify: `bot/src/types.ts:44-51`
- Test: `bot/tests/messageHandler.test.ts`

**Step 1: Write failing tests for attachment handling in message handler**

Add to `bot/tests/messageHandler.test.ts`:

```typescript
describe('voice attachment handling', () => {
  it('should include voice attachment info in query when present', async () => {
    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
    });

    await handler.handleMessage('g1', 'Alice', '@bot', 1000, [
      { id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null },
    ]);

    const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0];
    const lastUserMsg = messages[messages.length - 1];
    expect(lastUserMsg.content).toContain('[Voice message attached:');
    expect(lastUserMsg.content).toContain('voice-abc');
  });

  it('should treat voice-only message with trigger as mentioned', async () => {
    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
    });

    await handler.handleMessage('g1', 'Alice', '@bot', 1000, [
      { id: 'voice-xyz', contentType: 'audio/aac', size: 3000, filename: null },
    ]);

    expect(mockLLM.generateResponse).toHaveBeenCalled();
  });

  it('should ignore non-audio attachments', async () => {
    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
    });

    await handler.handleMessage('g1', 'Alice', '@bot check this image', 1000, [
      { id: 'image-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' },
    ]);

    const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0];
    const lastUserMsg = messages[messages.length - 1];
    expect(lastUserMsg.content).not.toContain('[Voice message attached:');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: FAIL — `handleMessage` doesn't accept attachments parameter

**Step 3: Add `attachmentsDir` to config and `MessageContext`**

In `bot/src/config.ts`, add `attachmentsDir: string` to `ConfigType` and set it in `Config.load()`:
```typescript
attachmentsDir: process.env.ATTACHMENTS_DIR || './data/signal-attachments',
```

In `bot/src/types.ts`, add `attachmentsDir: string` to `MessageContext` and `whisperModelPath: string`.

**Step 4: Update `handleMessage` signature and implementation**

In `bot/src/messageHandler.ts`:

1. Add `attachmentsDir` to constructor options and store as `this.attachmentsDir`.

2. Change `handleMessage` signature to accept optional attachments:
```typescript
async handleMessage(
  groupId: string,
  sender: string,
  content: string,
  timestamp: number,
  attachments: SignalAttachment[] = [],
): Promise<void>
```

3. After `extractQuery`, filter voice attachments and append info to the query:
```typescript
const voiceAttachments = attachments.filter(a => a.contentType.startsWith('audio/'));
let queryWithAttachments = query;
if (voiceAttachments.length > 0) {
  const attachmentLines = voiceAttachments.map(
    a => `[Voice message attached: ${path.join(this.attachmentsDir, a.id)}]`
  );
  queryWithAttachments = query
    ? `${query}\n\n${attachmentLines.join('\n')}`
    : attachmentLines.join('\n');
}
```

4. Pass `queryWithAttachments` instead of `query` to `buildContext`.

5. Add a system prompt instruction about voice transcription. In the `buildContext` time context section, add:
```typescript
`When a voice message is attached, use the transcribe_audio tool to transcribe it, then respond to the transcribed content as if the user had typed it.`,
```

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add bot/src/types.ts bot/src/config.ts bot/src/messageHandler.ts bot/tests/messageHandler.test.ts
git commit -m "feat: surface voice attachments to Claude via message handler"
```

---

### Task 3: Update index.ts and claudeClient.ts to wire attachments through

**Files:**
- Modify: `bot/src/index.ts:78-86`
- Modify: `bot/src/claudeClient.ts:17-34, 135-186`
- Test: `bot/tests/claudeClient.test.ts`

**Step 1: Write failing test for transcription MCP server in Claude config**

Add to `bot/tests/claudeClient.test.ts`:

```typescript
it('should include transcription MCP server in config when context is provided', async () => {
  mockSpawnSuccess(makeResultOutput('Transcribed!'));

  const client = new ClaudeCLIClient();
  const messages: ChatMessage[] = [{ role: 'user', content: 'Transcribe this' }];
  const context = {
    groupId: 'test-group',
    sender: '+61400000000',
    dbPath: '/tmp/test.db',
    timezone: 'Australia/Sydney',
    githubRepo: 'owner/repo',
    sourceRoot: '/app/source',
    attachmentsDir: '/app/signal-attachments',
    whisperModelPath: '/models/ggml-large.bin',
  };

  await client.generateResponse(messages, context);

  const args = mockSpawn.mock.calls[0][1];
  const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
  const mcpConfig = JSON.parse(args[mcpConfigIdx]);

  expect(mcpConfig.mcpServers.transcription).toBeDefined();
  expect(mcpConfig.mcpServers.transcription.env.WHISPER_MODEL_PATH).toBe('/models/ggml-large.bin');
  expect(mcpConfig.mcpServers.transcription.env.ATTACHMENTS_DIR).toBe('/app/signal-attachments');
});

it('should include transcription tool in allowed tools', async () => {
  mockSpawnSuccess(makeResultOutput('Done!'));

  const client = new ClaudeCLIClient();
  await client.generateResponse([{ role: 'user', content: 'Hi' }]);

  const args = mockSpawn.mock.calls[0][1];
  const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
  const allowedTools = args[allowedToolsIdx];

  expect(allowedTools).toContain('mcp__transcription__transcribe_audio');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/claudeClient.test.ts`
Expected: FAIL — no transcription server in config, no transcription tool in allowed tools

**Step 3: Update claudeClient.ts**

1. Add `'mcp__transcription__transcribe_audio'` to the `MCP_TOOLS` array (line 18-33).

2. Add `attachmentsDir` and `whisperModelPath` to `MessageContext` type in `types.ts` (already partially done in Task 2).

3. In `generateResponse`, add the transcription MCP server to the config. The transcription server is a **compiled Rust binary**, not a TS file, so it uses a different resolution path. Add a helper or inline config:

```typescript
// Resolve transcription binary: check for compiled binary, fall back to cargo run
const transcriptionBin = resolveTranscriptionBinary();

// Add to mcpServers object:
transcription: {
  command: transcriptionBin.command,
  args: transcriptionBin.args,
  env: {
    WHISPER_MODEL_PATH: context.whisperModelPath || '',
    ATTACHMENTS_DIR: context.attachmentsDir || '',
  },
},
```

For `resolveTranscriptionBinary()`:
```typescript
function resolveTranscriptionBinary(): { command: string; args: string[] } {
  const binPath = path.resolve(__dirname, '..', '..', 'transcription', 'target', 'release', 'signal-bot-transcription');
  if (fs.existsSync(binPath)) {
    return { command: binPath, args: [] };
  }
  // Dev fallback: cargo run
  const cargoPath = path.resolve(__dirname, '..', '..', 'transcription');
  return { command: 'cargo', args: ['run', '--release', '--manifest-path', `${cargoPath}/Cargo.toml`] };
}
```

**Step 4: Update index.ts to pass attachments through**

In `bot/src/index.ts:78-86`, update the message handling code:

```typescript
const data = signalClient.extractMessageData(signalMsg);

if (data) {
  if (config.testChannelOnly && data.groupId !== config.testGroupId) {
    continue;
  }
  console.log(`[${data.groupId}] ${data.sender}: ${data.content.substring(0, 50)}...`);
  await messageHandler.handleMessage(data.groupId, data.sender, data.content, data.timestamp, data.attachments);
}
```

Also update the `messageHandler` constructor call to pass `attachmentsDir`, and update the `llmClient.generateResponse` context to include `attachmentsDir` and `whisperModelPath`.

Update `config.ts` to include `whisperModelPath`:
```typescript
whisperModelPath: process.env.WHISPER_MODEL_PATH || '',
```

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add bot/src/index.ts bot/src/claudeClient.ts bot/src/config.ts bot/src/types.ts bot/tests/claudeClient.test.ts
git commit -m "feat: wire transcription MCP server into Claude CLI config"
```

---

### Task 4: Create the Rust transcription MCP server — project setup

**Files:**
- Create: `transcription/Cargo.toml`
- Create: `transcription/src/main.rs`

**Step 1: Create project directory and Cargo.toml**

```bash
mkdir -p transcription/src
```

Write `transcription/Cargo.toml`:
```toml
[package]
name = "signal-bot-transcription"
version = "0.1.0"
edition = "2021"

[features]
default = ["cuda"]
cuda = ["whisper-rs/cuda"]

[dependencies]
whisper-rs = "0.15"
symphonia = { version = "0.5", features = ["aac", "isomp4", "ogg", "vorbis", "mp3", "wav", "pcm"] }
rubato = "0.14"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
log = "0.4"
env_logger = "0.11"
```

**Step 2: Create minimal main.rs with MCP protocol stub**

Write `transcription/src/main.rs` with:
- JSON-RPC stdio loop (read lines from stdin, parse, dispatch, write to stdout)
- `initialize` handler returning protocol version `2025-03-26` and `{ tools: {} }`
- `notifications/initialized` handler (noop)
- `tools/list` handler returning the `transcribe_audio` tool definition
- `tools/call` handler that dispatches to a stub returning `"transcription not yet implemented"`

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

fn tool_definition() -> Value {
    serde_json::json!({
        "name": "transcribe_audio",
        "description": "Transcribe a voice message audio file to text using Whisper",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the audio file"
                }
            },
            "required": ["file_path"]
        }
    })
}

fn main() {
    env_logger::init();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                let _ = writeln!(stdout, "{}", err_resp);
                continue;
            }
        };

        let response = handle_request(&req);
        if let Some(resp) = response {
            let json = serde_json::to_string(&resp).unwrap();
            let _ = writeln!(stdout, "{}", json);
            let _ = stdout.flush();
        }
    }
}

fn handle_request(req: &JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => Some(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "signal-bot-transcription", "version": "1.0.0" }
            })),
            error: None,
        }),
        "notifications/initialized" => None,
        "tools/list" => Some(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(serde_json::json!({ "tools": [tool_definition()] })),
            error: None,
        }),
        "tools/call" => {
            let result = handle_tool_call(req.params.as_ref());
            Some(JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(result),
                error: None,
            })
        }
        _ => {
            if req.id.is_some() {
                Some(JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(serde_json::json!({
                        "code": -32601,
                        "message": format!("Method not found: {}", req.method)
                    })),
                })
            } else {
                None
            }
        }
    }
}

fn handle_tool_call(params: Option<&Value>) -> Value {
    let tool_name = params
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");

    match tool_name {
        "transcribe_audio" => {
            let file_path = params
                .and_then(|p| p.get("arguments"))
                .and_then(|a| a.get("file_path"))
                .and_then(|f| f.as_str())
                .unwrap_or("");

            if file_path.is_empty() {
                return serde_json::json!({
                    "content": [{ "type": "text", "text": "Missing file_path argument" }],
                    "isError": true
                });
            }

            match transcribe_file(file_path) {
                Ok(text) => serde_json::json!({
                    "content": [{ "type": "text", "text": text }]
                }),
                Err(e) => serde_json::json!({
                    "content": [{ "type": "text", "text": format!("Transcription error: {}", e) }],
                    "isError": true
                }),
            }
        }
        _ => serde_json::json!({
            "content": [{ "type": "text", "text": format!("Unknown tool: {}", tool_name) }],
            "isError": true
        }),
    }
}

fn transcribe_file(_file_path: &str) -> Result<String, String> {
    Err("Transcription not yet implemented".to_string())
}
```

**Step 3: Verify it compiles**

Run: `cd transcription && cargo build`
Expected: Compiles successfully

**Step 4: Commit**

```bash
git add transcription/
git commit -m "feat: scaffold Rust transcription MCP server with stdio JSON-RPC"
```

---

### Task 5: Implement audio decoding in Rust

**Files:**
- Create: `transcription/src/audio.rs`
- Modify: `transcription/src/main.rs`

**Step 1: Write audio decode module**

Create `transcription/src/audio.rs` that:
1. Opens an audio file with `symphonia` (auto-detect codec — AAC, OGG/Opus, MP3, WAV)
2. Decodes all packets to interleaved f32 PCM
3. Downmixes to mono (average channels)
4. Resamples to 16kHz using `rubato::SincFixedIn`

Key function signature:
```rust
pub fn decode_audio_file(path: &str) -> Result<Vec<f32>, String>
```

Port the resampling logic from lcars-voice `recording.rs`:
- `rubato::SincFixedIn::<f64>` with sinc interpolation params
- 256-tap, 0.95 cutoff, BlackmanHarris2 window, 1024 chunk size
- Target rate: 16000

For symphonia decoding, use the `SymphoniaDecoder` pattern:
```rust
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub fn decode_audio_file(path: &str) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let hint = Hint::new();
    // Don't set hint extension — let symphonia auto-detect (signal-cli files have no extension)

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Failed to probe audio format: {}", e))?;

    let mut format = probed.format;
    let track = format.default_track()
        .ok_or("No audio track found")?;
    let sample_rate = track.codec_params.sample_rate
        .ok_or("Unknown sample rate")?;
    let channels = track.codec_params.channels
        .ok_or("Unknown channel layout")?
        .count();
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("Error reading packet: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder.decode(&packet)
            .map_err(|e| format!("Decode error: {}", e))?;

        let spec = *decoded.spec();
        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        samples.extend_from_slice(sample_buf.samples());
    }

    // Downmix to mono
    let mono = if channels > 1 {
        downmix_to_mono(&samples, channels)
    } else {
        samples
    };

    // Resample to 16kHz if needed
    if sample_rate != 16000 {
        resample_to_16khz(&mono, sample_rate)
    } else {
        Ok(mono)
    }
}

fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample_to_16khz(samples: &[f32], source_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction, Resampler};

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let ratio = 16000.0 / source_rate as f64;
    let mut resampler = SincFixedIn::<f64>::new(
        ratio, 2.0, params, 1024, 1,
    ).map_err(|e| format!("Failed to create resampler: {}", e))?;

    let samples_f64: Vec<f64> = samples.iter().map(|&s| s as f64).collect();
    let mut output = Vec::new();

    for chunk in samples_f64.chunks(1024) {
        let mut input = vec![chunk.to_vec()];
        // Pad last chunk if needed
        if input[0].len() < 1024 {
            input[0].resize(1024, 0.0);
        }
        let result = resampler.process(&input, None)
            .map_err(|e| format!("Resampling error: {}", e))?;
        output.extend(result[0].iter().map(|&s| s as f32));
    }

    Ok(output)
}
```

**Step 2: Add module to main.rs**

Add `mod audio;` to `transcription/src/main.rs`.

**Step 3: Write unit tests for downmix and resample**

Add tests in `audio.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_downmix_stereo_to_mono() {
        let stereo = vec![1.0, 0.0, 0.5, 0.5, 0.0, 1.0];
        let mono = downmix_to_mono(&stereo, 2);
        assert_eq!(mono.len(), 3);
        assert!((mono[0] - 0.5).abs() < 1e-6);
        assert!((mono[1] - 0.5).abs() < 1e-6);
        assert!((mono[2] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_downmix_mono_passthrough() {
        let mono_input = vec![0.1, 0.2, 0.3];
        let result = downmix_to_mono(&mono_input, 1);
        assert_eq!(result, mono_input);
    }
}
```

**Step 4: Verify it compiles and tests pass**

Run: `cd transcription && cargo test`
Expected: PASS

**Step 5: Commit**

```bash
git add transcription/src/audio.rs transcription/src/main.rs
git commit -m "feat: add audio decoding with symphonia and rubato resampling"
```

---

### Task 6: Implement whisper transcription in Rust

**Files:**
- Create: `transcription/src/transcribe.rs`
- Modify: `transcription/src/main.rs`

**Step 1: Write transcription module**

Create `transcription/src/transcribe.rs` porting the logic from lcars-voice `transcription.rs`. Remove all Tauri dependencies, remove `app` parameter, remove VAD (can be added later):

```rust
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use std::sync::OnceLock;

static WHISPER_CTX: OnceLock<WhisperContext> = OnceLock::new();

const CHUNK_SIZE: usize = 16000 * 60 * 5;
const CHUNK_OVERLAP: usize = 16000;

pub fn init_model(model_path: &str) -> Result<(), String> {
    if WHISPER_CTX.get().is_some() {
        return Ok(());
    }

    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.use_gpu(cfg!(feature = "cuda"));
    ctx_params.flash_attn(cfg!(feature = "cuda"));

    let ctx = WhisperContext::new_with_params(model_path, ctx_params)
        .map_err(|e| format!("Failed to load whisper model: {}", e))?;

    WHISPER_CTX.set(ctx).map_err(|_| "Model already initialized".to_string())?;
    Ok(())
}

pub fn transcribe(audio_data: &[f32]) -> Result<String, String> {
    let ctx = WHISPER_CTX.get().ok_or("Whisper model not initialized")?;

    if audio_data.len() <= CHUNK_SIZE {
        return transcribe_single(ctx, audio_data);
    }

    // Chunk long audio
    let mut texts = Vec::new();
    let chunks = compute_chunks(audio_data.len(), CHUNK_SIZE, CHUNK_OVERLAP);
    for (start, end) in &chunks {
        let chunk = &audio_data[*start..*end];
        let text = transcribe_single(ctx, chunk)?;
        texts.push(text);
    }

    let combined = texts.join(" ");
    Ok(detect_and_remove_repetitions(&combined).trim().to_string())
}

fn transcribe_single(ctx: &WhisperContext, audio_data: &[f32]) -> Result<String, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_nst(true);
    params.set_no_context(true);
    params.set_entropy_thold(2.0);
    params.set_logprob_thold(-0.5);
    params.set_temperature_inc(0.4);
    params.set_max_tokens(256);

    let mut state = ctx.create_state()
        .map_err(|e| format!("Failed to create state: {}", e))?;

    state.full(params, audio_data)
        .map_err(|e| format!("Whisper inference failed: {}", e))?;

    let num_segments = state.full_n_segments();
    let mut text = String::new();

    for i in 0..num_segments {
        if let Some(segment) = state.get_segment(i) {
            if segment.no_speech_probability() > 0.8 {
                continue;
            }
            if let Ok(s) = segment.to_str() {
                text.push_str(s);
            }
        }
    }

    Ok(detect_and_remove_repetitions(&text).trim().to_string())
}

// Port compute_chunks from lcars-voice
fn compute_chunks(total_len: usize, chunk_size: usize, overlap: usize) -> Vec<(usize, usize)> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < total_len {
        let end = (start + chunk_size).min(total_len);
        chunks.push((start, end));
        if end == total_len { break; }
        start = end.saturating_sub(overlap);
    }
    chunks
}

// Port detect_and_remove_repetitions from lcars-voice
pub fn detect_and_remove_repetitions(text: &str) -> String {
    if text.is_empty() { return String::new(); }

    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 4 { return text.to_string(); }

    let max_ngram = (words.len() / 3).min(50);
    for ngram_size in (1..=max_ngram).rev() {
        let max_repeats = if ngram_size <= 2 { 4 } else { 2 };
        if words.len() < ngram_size * (max_repeats + 1) { continue; }

        let mut i = 0;
        while i + ngram_size <= words.len() {
            let ngram = &words[i..i + ngram_size];
            let mut repeat_count = 1;
            let mut j = i + ngram_size;
            while j + ngram_size <= words.len() {
                if &words[j..j + ngram_size] == ngram {
                    repeat_count += 1;
                    j += ngram_size;
                } else {
                    break;
                }
            }
            if repeat_count > max_repeats {
                let before = &words[..i + ngram_size];
                let after = &words[j..];
                let mut result_words: Vec<&str> = before.to_vec();
                result_words.extend_from_slice(after);
                return detect_and_remove_repetitions(&result_words.join(" "));
            }
            i += 1;
        }
    }
    text.to_string()
}
```

**Step 2: Wire transcribe_file in main.rs**

Update `transcribe_file` in `main.rs`:
```rust
mod audio;
mod transcribe;

fn transcribe_file(file_path: &str) -> Result<String, String> {
    // Lazy-init model on first call
    let model_path = std::env::var("WHISPER_MODEL_PATH")
        .map_err(|_| "WHISPER_MODEL_PATH env var not set".to_string())?;
    transcribe::init_model(&model_path)?;

    let audio_data = audio::decode_audio_file(file_path)?;
    if audio_data.is_empty() {
        return Err("Audio file is empty or contains no audio data".to_string());
    }

    transcribe::transcribe(&audio_data)
}
```

**Step 3: Write unit tests for repetition detection and chunking**

Add tests in `transcribe.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repetition_clean_text_unchanged() {
        let input = "Hello world this is normal text";
        assert_eq!(detect_and_remove_repetitions(input), input);
    }

    #[test]
    fn test_repetition_phrase_loop_truncated() {
        let input = "Real content. I said this. I said this. I said this. I said this.";
        let result = detect_and_remove_repetitions(input);
        assert!(result.contains("Real content."));
        let count = result.matches("I said this.").count();
        assert!(count <= 2);
    }

    #[test]
    fn test_repetition_empty_input() {
        assert_eq!(detect_and_remove_repetitions(""), "");
    }

    #[test]
    fn test_compute_chunks_short() {
        let chunks = compute_chunks(1000, CHUNK_SIZE, CHUNK_OVERLAP);
        assert_eq!(chunks, vec![(0, 1000)]);
    }

    #[test]
    fn test_compute_chunks_multiple() {
        let total = 6_000_000;
        let chunks = compute_chunks(total, CHUNK_SIZE, CHUNK_OVERLAP);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks.last().unwrap().1, total);
    }
}
```

**Step 4: Verify it compiles and tests pass**

Run: `cd transcription && cargo test`
Expected: PASS (unit tests for repetition detection and chunking; transcription integration tests need the model)

**Step 5: Commit**

```bash
git add transcription/src/transcribe.rs transcription/src/main.rs
git commit -m "feat: implement whisper transcription with chunking and anti-hallucination"
```

---

### ~~Task 7: Update Docker configuration~~ (REMOVED — running locally only)

---

### Task 8: End-to-end verification

**Step 1: Run full TypeScript test suite**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 2: Run Rust test suite**

Run: `cd transcription && cargo test`
Expected: ALL PASS

**Step 3: Build Rust binary in release mode**

Run: `cd transcription && cargo build --release`
Expected: Binary at `transcription/target/release/signal-bot-transcription`

**Step 4: Manual smoke test the MCP server**

Test the Rust binary directly via stdin/stdout:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | ./transcription/target/release/signal-bot-transcription
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ./transcription/target/release/signal-bot-transcription
```

Expected: Valid JSON-RPC responses with server info and tool definition.

**Step 5: Commit any fixups**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```

---

## Summary

| Task | Description | Estimated Steps |
|------|-------------|----------------|
| 1 | Extend types with attachments, update signalClient | 8 steps |
| 2 | Update messageHandler for voice attachments | 7 steps |
| 3 | Wire claudeClient and index.ts | 6 steps |
| 4 | Scaffold Rust MCP server | 4 steps |
| 5 | Implement audio decoding (symphonia + rubato) | 5 steps |
| 6 | Implement whisper transcription | 5 steps |
| ~~7~~ | ~~Update Docker config~~ | ~~REMOVED~~ |
| 8 | End-to-end verification | 5 steps |

Tasks 1-3 are TypeScript changes (can be tested with vitest).
Tasks 4-6 are Rust changes (independent from TS, can be parallelized).
Task 8 verifies everything works together.
