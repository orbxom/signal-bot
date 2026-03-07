# Image Attachment Support - API Research

Research for GitHub Issue #2: "Support image attachments in messages"

---

## 1. signal-cli JSON-RPC API - Attachment Handling

### Receiving Attachments

When signal-cli receives a message with attachments, the JSON-RPC `receive` notification includes an `attachments` array on `dataMessage`:

```json
{
  "jsonrpc": "2.0",
  "method": "receive",
  "params": {
    "envelope": {
      "source": "+33123456789",
      "timestamp": 1631458508784,
      "dataMessage": {
        "timestamp": 1631458508784,
        "message": "Check this out",
        "attachments": [
          {
            "id": "attachment-id-string",
            "contentType": "image/jpeg",
            "size": 245760,
            "filename": "photo.jpg"
          }
        ]
      }
    }
  }
}
```

**Attachment fields** (already typed in `bot/src/types.ts` as `SignalAttachment`):
- `id` (string) - Unique identifier for retrieving the attachment
- `contentType` (string) - MIME type (e.g., `image/jpeg`, `image/png`)
- `size` (number) - File size in bytes
- `filename` (string | null) - Original filename, may be null

### Downloading/Accessing Attachments

**GET /attachments/{id}** - Retrieves raw attachment data as Base64:

```
GET /attachments/{id}?recipient=+1234567890
GET /attachments/{id}?group-id=GROUP_ID
```

Response:
```json
{
  "data": "BASE64_ENCODED_ATTACHMENT_DATA..."
}
```

Alternatively, signal-cli stores attachments on disk. The bot already has an `attachmentsDir` config (`AppConfig.attachmentsDir`), and the `ContextBuilder` already constructs file paths as `path.join(attachmentsDir, attachmentId)`.

### Sending Attachments

The `send` method accepts an `attachments` array of file paths or **data URIs** (RFC 2397):

```json
{
  "jsonrpc": "2.0",
  "method": "send",
  "params": {
    "groupId": "GROUP_ID",
    "message": "Here's an image",
    "attachments": ["/path/to/image.jpg"]
  }
}
```

Data URI format also supported: `data:image/png;base64,<BASE64_DATA>`

**Key finding:** The bot's `signal.ts` MCP server already implements `send_image` using data URIs with base64.

### Gotchas
- `filename` can be null on received attachments
- Attachment files are stored locally by signal-cli daemon; the path is `{attachments-dir}/{attachment-id}`
- No file extension on stored files - must rely on `contentType` to determine format

---

## 2. Claude CLI (`claude -p`) - Image Input

### Current Bot Architecture

The bot spawns `claude -p <prompt>` with `--output-format json`. The prompt is built as a plain text string from conversation history. Currently, **images are referenced as text placeholders** like `[Image attached: /path/to/file]` and Claude is instructed to use the `Read` tool to view them.

### How Claude CLI Accepts Images

Claude Code CLI is multimodal - it can read image files directly using its built-in Read tool. From the codebase's `contextBuilder.ts`:

```
IMAGE_INSTRUCTIONS = 'When an image is attached (shown as [Image attached: <path>] in the conversation), use the Read tool to view it...'
```

This means the current approach works: Claude CLI reads the image file from disk via its Read tool, which supports PNG, JPG, etc.

### Limitations

- The `-p` (prompt) flag accepts text only - you cannot embed binary image data in the prompt string itself
- Images must be provided as **file paths** that Claude's Read tool can access
- This means attachments must be saved to disk before Claude can see them
- The Read tool is a built-in tool, not an MCP tool, so it's always available

### Implication for Architecture

The current approach of `[Image attached: /path/to/file]` + instructing Claude to use Read tool is the correct pattern. The key requirement is that:
1. signal-cli must save attachment files to a known directory
2. The file paths must be accessible to the Claude CLI process
3. The `attachmentsDir` config must point to where signal-cli stores them

---

## 3. Anthropic Messages API - Image Format

### Image Content Blocks

The Messages API supports images as content blocks in the `messages` array:

```typescript
// Base64 source
{
  type: "image",
  source: {
    type: "base64",
    media_type: "image/jpeg",  // or image/png, image/gif, image/webp
    data: "<base64-encoded-string>"
  }
}

// URL source
{
  type: "image",
  source: {
    type: "url",
    url: "https://example.com/image.jpg"
  }
}
```

### Supported Media Types
- `image/jpeg`
- `image/png`
- `image/gif`
- `image/webp`

### TypeScript SDK Example

```typescript
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

const imageData = fs.readFileSync('/path/to/image.png');
const base64Image = imageData.toString('base64');

const message = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: 'Describe this image in detail.',
        },
      ],
    },
  ],
});
```

### Relevance to This Project

Since the bot uses `claude -p` (CLI) rather than the Messages API directly, this is **informational only**. The CLI handles the API translation internally. However, if the project ever migrates from CLI to direct API calls, this is the format needed.

### Tool Results Can Include Images

The TypeScript SDK supports returning images from tool calls:

```typescript
return {
  type: 'image',
  source: {
    type: 'base64',
    data: screenshotBase64,
    media_type: 'image/png'
  }
};
```

---

## 4. MCP Protocol - Image Content in Tool Results

### Image Content Type

MCP tool results can include image content blocks alongside text:

```json
{
  "type": "image",
  "data": "base64-encoded-data",
  "mimeType": "image/png"
}
```

**Note the field name difference:** MCP uses `mimeType` (not `media_type` like the Anthropic API).

### With Annotations (MCP 2025-06-18 spec)

```json
{
  "type": "image",
  "data": "base64-encoded-data",
  "mimeType": "image/png",
  "annotations": {
    "audience": ["user"],
    "priority": 0.9
  }
}
```

### Binary Resources

MCP also supports binary content in resources using `blob` field:

```json
{
  "uri": "file:///example.png",
  "mimeType": "image/png",
  "blob": "base64-encoded-data"
}
```

### Sampling Messages

MCP sampling (server-initiated LLM requests) supports image content:

```json
{
  "type": "image",
  "data": "base64-encoded-image-data",
  "mimeType": "image/jpeg"
}
```

### Relevance to This Project

If we wanted an MCP tool to return image data directly (e.g., a `get_attachment` tool that returns the image to Claude), we could use the image content type. However, since Claude CLI's Read tool can already read image files from disk, this may be unnecessary complexity.

---

## 5. Current Codebase Status (What Already Works)

The codebase already has **significant infrastructure** for image attachments:

### Already Implemented
1. **`SignalAttachment` type** (`bot/src/types.ts:100-105`) - id, contentType, size, filename
2. **`SignalMessage` schema** includes `attachments` array on `dataMessage`
3. **`extractMessageData`** (`signalClient.ts:88-106`) - Already extracts attachments and passes them through. Messages with attachments but no text ARE accepted (line 95: `hasAttachments` check).
4. **`ExtractedMessage`** includes `attachments: SignalAttachment[]`
5. **`Message` type** has optional `attachments?: SignalAttachment[]`
6. **`ContextBuilder`** has:
   - `formatImageAttachmentLines()` - filters for `image/*` content types
   - `formatImageAttachment()` - creates `[Image attached: <path>]` strings
   - `IMAGE_INSTRUCTIONS` constant telling Claude to use Read tool
7. **`MessageHandler`** (`messageHandler.ts:291-305`) already:
   - Filters attachments by `image/*` content type
   - Appends `[Image attached: <path>]` to the query
   - Logs attachment counts
8. **`signal.ts` MCP server** has `send_image` tool for sending images back
9. **`AppConfig.attachmentsDir`** configuration exists

### What May Be Missing / Needs Verification
1. **Attachment file storage** - Does signal-cli actually save files to `attachmentsDir`? Or do we need to download them via the API?
2. **File extension handling** - signal-cli stores files by ID without extension; Claude's Read tool may need the correct file type to render images
3. **Attachment storage in DB** - The `addMessage` call includes attachments, but need to verify the SQLite schema stores them
4. **Image size limits** - Large images could bloat Claude's context; may need resizing
5. **Non-image attachments** - Video, documents, etc. are currently ignored

---

## 6. Recommended Implementation Path

Based on this research, the main gaps are:

1. **Verify attachment file availability** - Confirm signal-cli daemon saves attachments to disk at the configured `attachmentsDir`, or implement downloading via the `GET /attachments/{id}` API endpoint.

2. **Test the Read tool flow** - Verify Claude CLI's Read tool can open attachment files (which lack file extensions) and render them as images based on content.

3. **Database schema for attachments** - Ensure the message store persists attachment metadata so historical messages retain their attachment references.

4. **Consider a dedicated MCP tool** - An `get_image_attachment` MCP tool that reads the file and returns it as an MCP image content block could be more reliable than relying on Claude's Read tool finding files without extensions.

5. **Image resizing** - For large photos, consider resizing before passing to Claude to manage token costs (images consume tokens based on pixel count).
