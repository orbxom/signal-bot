# Research: Issue #5 — Fetch and Post BOM Radar Images

## Key Findings

### 1. Image Sending Already Works
- `bot/src/mcp/servers/signal.ts` has a `send_image` tool that reads a file, converts to base64 data URI, sends via signal-cli JSON-RPC
- Supports PNG, JPG, GIF, WebP; 10MB limit
- `claudeClient.ts` already detects and logs `mcp__signal__send_image` calls
- `messageHandler.ts` routes both text and image responses correctly
- **No changes needed to the signal/messaging stack**

### 2. BOM Radar URL Patterns
- Pre-composited animated GIFs at `https://reg.bom.gov.au/radar/IDR{station}{range}.gif`
- **Must use `reg.bom.gov.au`** — `www.bom.gov.au` returns 403 Forbidden
- Product ID format: `IDR` + 2-digit station + 1-digit range (1=512km, 2=256km, 3=128km, 4=64km)
- GIFs are ~30KB, 524x564px, updated every ~5-6 minutes
- Background, topography, locations, range rings, legend all baked in

### 3. Station Mapping (Common)
| Station | Code | Location |
|---------|------|----------|
| Sydney/Terrey Hills | 71 | NSW |
| Melbourne | 02 | VIC |
| Brisbane | 66 | QLD |
| Adelaide | 64 | SA |
| Perth | 70 | WA |
| Newcastle | 04 | NSW |
| Canberra | 40 | ACT |
| Hobart | 37 | TAS |
| Darwin | 63 | NT |

### 4. Weather MCP Server (Current State)
- `bot/src/mcp/servers/weather.ts`: 4 tools using `https://api.weather.bom.gov.au/v1`
- Uses geohash-based location lookup
- Pattern: `catchErrors()` wrapper, `requireString()` validation, `ok()` responses
- Adding a tool = add to TOOLS array + handlers object

### 5. MCP Server Registration
- Add tool definition to weather.ts TOOLS array
- Add handler to handlers object
- **No other files need to change** — weather server already in ALL_SERVERS registry

### 6. Integration Flow
```
User: "show me the radar for Sydney"
→ Claude calls get_radar_image(location: "Sydney")
→ weather.ts maps "Sydney" → IDR713 (128km)
→ fetches https://reg.bom.gov.au/radar/IDR713.gif
→ saves to /tmp/radar-IDR713-{timestamp}.gif
→ returns file path
→ Claude calls send_image(imagePath: "/tmp/radar-IDR713-{timestamp}.gif", caption: "Sydney radar")
→ signal.ts reads file, base64 encodes, sends via signal-cli
```

### 7. Risk Assessment
- **LOW**: Tool registration, image format support, MCP framework
- **MEDIUM**: Temp file cleanup, network timeouts, BOM URL stability
- **HIGH**: Station mapping accuracy (hardcoded = fragile, but no API alternative)

### 8. Related Issues
- Issue #13 (Playwright MCP) is separate; broader vision for web screenshots
- Issue #2/#3 (image attachments) covers receiving; partially complete but not blocking #5
- No conflicting open issues

### 9. Prior Art
- `docs/research/image-attachment-api-research.md` — comprehensive image API research already exists
- Attachment types/DB schema already support images throughout the stack
