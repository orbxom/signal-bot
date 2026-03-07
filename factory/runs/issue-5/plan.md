# Implementation Plan: Issue #5 — Fetch and Post BOM Radar Images

## Goal

Enable the bot to fetch BOM radar images and send them as image attachments in Signal group chat, so when a user says "show me the radar for Sydney", they get an actual radar image.

**Acceptance Criteria:**
1. New `get_radar_image` MCP tool on the weather server
2. Takes a location name, maps to nearest BOM radar station
3. Downloads the radar GIF from BOM
4. Saves to temp file and returns the path
5. Claude chains this with the existing `send_image` tool to deliver the image

## Approach

### Architecture Decision: Add tool to existing weather server

The `get_radar_image` tool belongs in `weather.ts` alongside the other BOM tools. It doesn't need geohash — it uses a hardcoded station mapping keyed by common location names. Claude will naturally discover the tool and chain it with `send_image`.

### Key Design Choices

1. **Hardcoded station mapping** — BOM has no API for radar station discovery. A static map of ~20 common Australian stations is sufficient and maintainable. We accept that adding new stations requires a code change — this is fine for the current user base (family group chat). Common aliases map to the same station (e.g., "sydney" and "terrey hills" both → station 71).

2. **Case-insensitive exact match** — Claude is the caller, not a human. It will pass well-formed location names. No need for fuzzy/partial matching logic. Simple `location.toLowerCase()` lookup with aliases as separate keys.

3. **Download to temp file** — Save the GIF to `os.tmpdir()` with a timestamp filename. Clean up old radar files (>1 hour) on each new request. The existing `send_image` tool reads from file path.

4. **Use `reg.bom.gov.au`** — Research confirmed `www.bom.gov.au` returns 403. Must use `https://reg.bom.gov.au` for HTTPS access.

5. **Pre-composited GIFs** — Use the `.gif` format which includes background, topography, locations, and legend baked in. Much simpler than compositing individual PNG layers.

6. **Default to 128km range** — Product suffix `3` (128km) is the most useful default. Allow optional `range` parameter for 64km/256km/512km.

7. **Content validation** — After fetching from BOM, verify the response is actually a GIF (check content-type header or GIF magic bytes `GIF89a`/`GIF87a`) before writing to file. If BOM returns an HTML error page, return a clear error rather than sending a corrupt file.

8. **Single tool, not two** — No separate `list_radar_stations` tool. When a location isn't found, the error message includes the full list of available stations. One tool covers both discovery and fetching.

## File Changes

### Modified Files

1. **`bot/src/mcp/servers/weather.ts`** — Add `get_radar_image` tool definition and handler
   - Add `RADAR_STATIONS` constant: `Record<string, { code: string; name: string }>` mapping lowercase location names/aliases to station codes
   - Add `RANGE_MAP` constant: range strings → BOM product suffixes
   - Add tool to TOOLS array with `location` (required) and `range` (optional) parameters
   - Add handler that: validates location → exact match lookup → fetches GIF → validates content → cleans old files → writes temp file → returns path
   - On unknown location: return error listing all available stations

2. **`bot/tests/weatherMcpServer.test.ts`** — Add tests for new tool
   - Tool count updated (4 → 5)
   - Test `get_radar_image` with valid location (verify GIF magic bytes)
   - Test `get_radar_image` with unknown location (error with station list)
   - Clean up temp files in afterEach

### No Changes Needed

- `bot/src/mcp/servers/signal.ts` — `send_image` already works
- `bot/src/mcp/servers/index.ts` — weather server already registered
- `bot/src/mcp/registry.ts` — auto-discovers tools
- `bot/src/messageHandler.ts` — already routes image responses
- `bot/src/claudeClient.ts` — already detects `send_image` calls

## Test Strategy

**TDD approach — tests hit real BOM servers (consistent with existing weather tests):**
1. Write test for tool count (4 → 5) and tool names list → update TOOLS array
2. Write test for `get_radar_image` with valid location → implement handler
3. Write test for unknown location error → implement error with station list
4. Write test for GIF content validation → implement magic byte check
5. Manual integration test via mock signal server

**Test details:**
- Verify downloaded file exists and starts with GIF magic bytes (`GIF89a` or `GIF87a`)
- Verify unknown location error includes available station names
- Clean up temp files after each test
- Timeout of 30s for network tests (BOM can be slow)

## Tasks

### Task 1: Add station mapping and tool definition
- Add `RADAR_STATIONS` constant with ~20 stations and common aliases
- Add `RANGE_MAP` constant (512km→1, 256km→2, 128km→3, 64km→4)
- Add `get_radar_image` to TOOLS array with `location` (required) and `range` (optional) params
- Update test: tool count 4 → 5, verify tool names list includes `get_radar_image`

### Task 2: Implement `get_radar_image` handler
- Validate location parameter via `requireString()`
- Case-insensitive exact match against `RADAR_STATIONS`
- On no match: return `error()` with formatted list of available stations
- Construct URL: `https://reg.bom.gov.au/radar/IDR{stationCode}{rangeSuffix}.gif`
- Fetch with `AbortSignal.timeout(30000)`
- Validate response: check HTTP status, verify content starts with GIF magic bytes
- Clean up old `radar-*.gif` files in tmpdir (>1 hour old)
- Write to `os.tmpdir()/radar-IDR{code}-{timestamp}.gif`
- Return `ok()` with file path and station name
- Write tests: valid location returns GIF path, unknown location returns error with station list

### Task 3: End-to-end verification
- Run full test suite
- Manual test via mock signal server if feasible
- Verify Claude can chain `get_radar_image` → `send_image`

## Revisions

Changes made after devil's advocate review:

1. **Removed `list_radar_stations` tool** — YAGNI. Station list is embedded in `get_radar_image` error messages instead. Tool count goes from 6 to 5.
2. **Simplified matching** — Replaced "case-insensitive, partial match" with case-insensitive exact match + aliases. Claude is the caller; it doesn't need fuzzy matching.
3. **Added temp file cleanup** — Clean up radar files older than 1 hour on each new request. Prevents accumulation.
4. **Added content validation** — Verify GIF magic bytes after fetching from BOM. Prevents sending corrupt files if BOM returns an HTML error page.
5. **Merged range parameter into main task** — Not a separate task; it's 5 lines of code.
6. **Consolidated from 5 tasks to 3** — Simpler, more focused task list.
