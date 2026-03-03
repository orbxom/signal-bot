# Voice Message Transcription via MCP Tool

## Overview

Add voice message transcription to the signal bot. When someone sends a voice clip with a mention trigger (e.g. `claude:` + voice note), Claude transcribes it using whisper-rs and responds to the content.

## Architecture

```
Signal voice message
  -> signal-cli stores attachment to disk
  -> Bot detects voice attachment, includes metadata in Claude context
  -> Claude calls transcribe_audio MCP tool with file path
  -> Rust MCP server decodes audio -> whisper-rs transcribes -> returns text
  -> Claude responds based on transcription
```

Four layers of changes: Docker infrastructure, TypeScript bot plumbing, new Rust MCP server, and integration/registration.

## Layer 1: Docker & Shared Volume

Add a shared read-only volume so the bot container can access signal-cli's downloaded attachments:

```yaml
# docker-compose.yml
bot:
  volumes:
    - ./data/bot:/app/data
    - ./data/signal-cli-config/attachments:/app/signal-attachments:ro  # NEW
```

Signal-cli stores attachments at `/var/lib/signal-cli/attachments/<id>` (mapped to `./data/signal-cli-config/attachments/` on host). The `id` from the message envelope is the filename, no extension.

## Layer 2: TypeScript Attachment Plumbing

### types.ts

Extend `SignalMessage.envelope.dataMessage` to include:

```typescript
attachments?: Array<{
  id: string;           // filename under attachments dir
  contentType: string;  // e.g. "audio/aac", "audio/ogg"
  size: number;
  filename: string | null;
}>;
```

### signalClient.ts

Update `extractMessageData()`:
- Return attachment metadata alongside text content
- Allow messages with attachments but empty/missing text body (currently these are dropped)
- Derive file path: `/app/signal-attachments/${attachment.id}`

### messageHandler.ts

When a message has audio attachments (`contentType` starting with `audio/`):
- Include file path in context: `"[Voice message attached: /app/signal-attachments/abc123]"`
- Add system prompt instruction telling Claude to use `transcribe_audio` tool for voice messages
- Mention detection must work on messages with minimal text (just trigger) plus attachments

## Layer 3: Rust MCP Server

### Project structure

New Rust crate at `transcription/` in the repo root:

```
transcription/
  Cargo.toml
  src/
    main.rs          # MCP stdio server + JSON-RPC loop
    transcribe.rs    # whisper-rs transcription (ported from lcars-voice)
    audio_decode.rs  # decode audio files to f32 PCM 16kHz mono
```

### Dependencies

| Crate | Purpose |
|---|---|
| `whisper-rs` 0.15 (`cuda` feature) | Transcription engine |
| `symphonia` | Audio decoding (AAC, OGG/Opus, MP3, WAV, FLAC) |
| `rubato` | Resampling to 16kHz |
| `serde` + `serde_json` | JSON-RPC message parsing |

### MCP protocol

Implements stdio JSON-RPC (newline-delimited JSON on stdin/stdout):
- `initialize` -> returns protocol version, capabilities `{ tools: {} }`, server info
- `notifications/initialized` -> acknowledged silently
- `tools/list` -> returns tool definitions
- `tools/call` -> dispatches to handler

### Tool definition

```json
{
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
}
```

### Lifecycle

- **On init**: Load whisper model once via `WhisperContext::new_with_params` with `use_gpu(true)` + `flash_attn(true)`. Model path from `WHISPER_MODEL_PATH` env var. Reuses existing `ggml-large.bin` from lcars-voice.
- **On tool call**: Decode -> resample -> infer -> return text.
- Context stays loaded across calls (process lives as long as the Claude CLI invocation).

### Transcription config (ported from lcars-voice)

- `SamplingStrategy::Greedy { best_of: 1 }`
- Language: `"en"`
- `suppress_nst(true)`, `no_context(true)`
- `entropy_thold(2.0)`, `logprob_thold(-0.5)`, `temperature_inc(0.4)`
- Skip segments with `no_speech_prob > 0.8`
- Repetition detection/removal
- 5-minute chunking with 1-second overlap (safety for long audio)

### Audio decode pipeline

1. `symphonia` opens file, auto-detects codec
2. Decode to interleaved f32 PCM at native sample rate
3. Downmix to mono (average channels)
4. `rubato::SincFixedIn` resample to 16kHz

## Layer 4: Integration & Registration

### claudeClient.ts

Add to tool allowlist:
```
"mcp__transcription__transcribe_audio"
```

Add MCP server config:
```json
{
  "transcription": {
    "command": "/path/to/transcription-mcp-server",
    "args": [],
    "env": {
      "WHISPER_MODEL_PATH": "/path/to/ggml-large.bin"
    }
  }
}
```

Dev mode: `cargo run --manifest-path transcription/Cargo.toml`
Production: compiled binary in Docker image.

### Dockerfile

Multi-stage build addition:
- Rust build stage compiles `transcription/` with CUDA
- Final image needs CUDA runtime libs + compiled binary
- Whisper model accessible via volume mount or baked in

### System prompt addition

```
When a voice message is attached, use the transcribe_audio tool to transcribe it,
then respond to the transcribed content as if the user had typed it.
```

## Edge Cases

- Multiple voice attachments in one message: transcribe each
- Voice clip + text: Claude uses both context and transcription
- Non-audio attachments (images, files): ignore, don't pass to transcription tool
- Empty transcription (silence/noise): Claude reports it couldn't understand
- Attachment not yet downloaded (race condition): error gracefully with retry guidance
