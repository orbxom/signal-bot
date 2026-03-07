# Research: BOM Radar Images in Signal Chat (Issue #5)

## 1. BOM Radar URL Patterns and Product IDs

### Product ID Structure

BOM radar product IDs follow the format: `IDR` + 2-digit station number + 1-digit range suffix.

**Range suffix meanings (last digit):**

| Suffix | Range  |
|--------|--------|
| 1      | 512 km |
| 2      | 256 km |
| 3      | 128 km |
| 4      | 64 km  |

### Common Station Numbers

| Station | Number | 128km ID | 256km ID | 512km ID | 64km ID |
|---------|--------|----------|----------|----------|---------|
| Sydney (Terrey Hills) | 71 | IDR713 | IDR712 | IDR711 | IDR714 |
| Melbourne (Laverton) | 02 | IDR023 | IDR022 | IDR021 | IDR024 |
| Brisbane (Mt Stapylton) | 66 | IDR663 | IDR662 | IDR661 | IDR664 |
| Adelaide (Buckland Park) | 64 | IDR643 | IDR642 | IDR641 | IDR644 |
| Perth (Serpentine) | 70 | IDR703 | IDR702 | IDR701 | IDR704 |
| Canberra (Captains Flat) | 40 | IDR403 | IDR402 | IDR401 | IDR404 |
| Hobart (Mt Koonya) | 76 | IDR763 | IDR762 | IDR761 | IDR764 |
| Darwin (Berrimah) | 63 | IDR633 | IDR632 | IDR631 | IDR634 |

### Working URLs (Verified 2026-03-07)

**Animated GIF (composite with legend, ~30KB, 524x564px):**
```
https://reg.bom.gov.au/radar/IDR713.gif
```
This is the simplest option -- a pre-composited animated GIF with background, topography, locations, range rings, and legend already baked in. Updated every ~6 minutes. This is the recommended approach for posting to Signal chat.

**Individual PNG radar frames (raw radar data only, 512x512px, ~3KB each):**
```
https://reg.bom.gov.au/radar/IDR713.T.202603061319.png
```
Naming: `IDR{id}.T.{YYYYMMDDHHmm}.png` -- timestamps are UTC. ~17 frames kept (last ~90 minutes at 5-min intervals).

**Transparency/overlay layers (for compositing PNG frames):**
```
https://reg.bom.gov.au/products/radar_transparencies/IDR713.background.png
https://reg.bom.gov.au/products/radar_transparencies/IDR713.topography.png
https://reg.bom.gov.au/products/radar_transparencies/IDR713.locations.png
https://reg.bom.gov.au/products/radar_transparencies/IDR713.range.png
```
Additional layers: `wthrDistricts`, `waterways`, `roads`, `rail`, `catchments`.

**Legend:** `https://reg.bom.gov.au/products/radar_transparencies/IDR.legend.0.png`

**FTP equivalents (also work, but not needed since HTTPS works):**
```
ftp://ftp.bom.gov.au/anon/gen/radar/IDR713.gif
ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/IDR713.background.png
```

### Important Notes

- `www.bom.gov.au` returns 403 Forbidden for direct image access (Akamai CDN blocks it). Use `reg.bom.gov.au` instead.
- The `.gif` file is the easiest single-fetch option. It is an animated GIF with all layers pre-composited.
- The individual `.T.{timestamp}.png` frames are transparent PNGs with only the radar data -- they need to be composited with background/topography/locations layers to be meaningful.
- Images are updated approximately every 5-6 minutes.
- Copyright: Free for personal use or within your organisation. Not for commercial redistribution.

### Recommendation for Implementation

Use the pre-composited animated GIF (`IDR{id}.gif`) for simplicity. It is a single HTTP fetch, already includes all layers, and is small (~30KB). The 128km range (suffix `3`) is the most useful default for city-level weather.

---

## 2. signal-cli Attachment Support

### Existing Implementation

The bot already has a working `send_image` tool in `/home/zknowles/personal/signal-bot/bot/src/mcp/servers/signal.ts` that:

1. Reads a file from disk (`fs.readFileSync`)
2. Converts to base64
3. Constructs a data URI: `data:{mime};base64,{data}`
4. Sends via JSON-RPC `send` method with `attachments: [dataUri]`

### JSON-RPC Format for Sending Attachments

```json
{
  "jsonrpc": "2.0",
  "method": "send",
  "id": "mcp-1234567890",
  "params": {
    "account": "+61XXXXXXXXXX",
    "groupId": "BASE64_GROUP_ID",
    "message": "Optional caption text",
    "attachments": ["data:image/gif;base64,R0lGODlh..."]
  }
}
```

**Key details:**
- `attachments` is an array (even for a single attachment)
- Supports data URI format per RFC 2397: `data:[<mediatype>][;base64],<data>`
- Also supports plain file paths (if signal-cli daemon can access the file)
- Optional filename in data URI: `data:image/gif;filename=radar.gif;base64,...`
- `message` field serves as the caption when sent alongside attachments
- Supported MIME types already mapped in the codebase: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- Max size in current implementation: 10MB (more than enough for radar GIFs at ~30KB)

### No Code Changes Needed to signal.ts

The existing `send_image` tool reads from a local file path. For the radar feature, there are two approaches:
1. **Download to temp file, then use existing `send_image`** -- works but adds an extra tool call
2. **New radar tool downloads and sends directly** -- more efficient, can reuse the `signalRpc` helper pattern

---

## 3. Node.js: Downloading Binary Images

### Using Built-in `fetch` (Node 18+)

```typescript
// Download binary data as Buffer
async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Convert to base64 data URI
const buffer = await downloadImage('https://reg.bom.gov.au/radar/IDR713.gif');
const base64 = buffer.toString('base64');
const dataUri = `data:image/gif;base64,${base64}`;
```

### Writing to Temp File (if needed)

```typescript
import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buffer = await downloadImage(url);
const tmpDir = mkdtempSync(join(tmpdir(), 'radar-'));
const tmpFile = join(tmpDir, 'radar.gif');
writeFileSync(tmpFile, buffer);
// ... use tmpFile ...
unlinkSync(tmpFile); // cleanup
```

### Key Considerations

- The BOM radar GIFs are small (~30KB) so base64 encoding in memory is fine (no streaming needed).
- `fetch` is built into Node 18+ (the bot uses Node 20+), no extra dependencies.
- FTP URLs do NOT work with `fetch` -- must use the HTTPS `reg.bom.gov.au` URLs.
- Always set a timeout (`AbortSignal.timeout`) to avoid hanging if BOM is slow.
- Verify `Content-Type` from response if you want to auto-detect mime type, though for known BOM URLs this is predictable.

---

## 4. MCP SDK and Binary/Image Data

Context7 was unavailable (quota exceeded), but based on the existing codebase patterns:

### Current MCP Tool Return Format

All MCP tools in this project return text via the `ok()` / `error()` helpers from `/home/zknowles/personal/signal-bot/bot/src/mcp/result.ts`. The MCP protocol supports returning images in tool results using the `image` content type:

```typescript
// MCP protocol supports this content type:
{
  type: "image",
  data: "<base64-encoded-image-data>",
  mimeType: "image/gif"
}
```

However, for this use case, the radar tool should NOT return the image as MCP content. Instead, it should:
1. Download the radar image
2. Send it directly to Signal via the `signalRpc('send', ...)` pattern
3. Return a text confirmation via `ok('Radar image sent.')`

This matches the existing `send_image` tool pattern -- the image goes to Signal, not back through MCP to Claude.

### Recommended Tool Design

The radar tool belongs in the weather MCP server (`weather.ts`) or as a new dedicated server. It would:
1. Accept a location name or station ID
2. Map to the correct IDR product code
3. Fetch the GIF from `https://reg.bom.gov.au/radar/{productId}.gif`
4. Send it to Signal as a base64 data URI attachment
5. Return confirmation text

The tool needs access to both `SIGNAL_CLI_URL` and the group context, which means it either:
- Lives in the signal server (has signal access but is semantically a weather tool)
- Lives in a new server that has both weather and signal env vars
- Downloads to a temp file and lets Claude use the existing `send_image` tool (simplest, two-step)

---

## Summary of Key Findings

| Topic | Finding |
|-------|---------|
| Best radar URL | `https://reg.bom.gov.au/radar/IDR{station}{range}.gif` -- pre-composited animated GIF |
| Default range | `3` (128km) is best for city-level views |
| File size | ~30KB per GIF, well within 10MB signal-cli limit |
| Image format | Animated GIF 524x564px with legend |
| signal-cli attachments | Already implemented in codebase: `data:image/gif;base64,...` in `attachments` array |
| Node.js download | `fetch()` + `Buffer.from(arrayBuffer)` + `.toString('base64')` -- no deps needed |
| HTTPS domain | Must use `reg.bom.gov.au`, NOT `www.bom.gov.au` (403 blocked) |
| Update frequency | Every ~5-6 minutes, ~17 frames retained |
