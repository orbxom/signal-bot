# Plan Review: Issue #5 — Fetch and Post BOM Radar Images

## 1. Is `list_radar_stations` necessary? — REMOVE IT

**Verdict: YAGNI. Cut this tool.**

The plan adds a whole tool just so Claude can "discover" stations. But think about how this actually plays out:

- If a user says "show me the radar for Sydney", Claude calls `get_radar_image(location: "Sydney")`. It works. No discovery needed.
- If a user says "show me the radar for Wagga Wagga" and it is not in the mapping, `get_radar_image` returns an error. That error message can (and should) include the list of available stations. Claude sees the list, tells the user. Same outcome, zero extra tools.

This is how the existing `search_location` / `get_observations` pattern does NOT work — those are separate because they serve fundamentally different data flows (geohash lookup vs weather data). Here, `list_radar_stations` returns static data that is only useful as a fallback when `get_radar_image` fails. Bake it into the error message.

**Concrete change:** Remove `list_radar_stations` from the plan. In the `get_radar_image` error handler for unknown locations, return the full station list in the error text. Tool count goes from 4 to 5 (not 6).

## 2. Hardcoded station mapping — ACCEPTABLE but document the tradeoff

**Verdict: Fine for now, but the plan understates the risk.**

The research says "BOM has no API for radar station discovery" and marks it HIGH risk. The plan then treats it as a settled decision without discussing alternatives:

- Could the BOM locations API (`/v1/locations/{geohash}/observations`) return a nearby radar station? The `station` field in observations includes a station name and distance. This might not map to radar stations, but the plan never explores it.
- The BOM website itself has a radar station selector at `reg.bom.gov.au/products/radar_transparencies.shtml` — could we scrape that once to build a more complete list?

That said, for an MVP targeting a family group chat in Australia, ~20 hardcoded stations is pragmatic. The plan should just acknowledge this explicitly: "We accept that adding new stations requires a code change. This is fine for the current user base."

**Concrete change:** No code change needed, but add a comment in the station mapping noting it is intentionally hardcoded and explaining how to add new stations.

## 3. Partial matching on location names — SIMPLIFY

**Verdict: Scope creep. Use case-insensitive exact match only.**

The plan says "case-insensitive, partial match" in Task 3. Partial matching introduces edge cases:

- "Darwin" matches "Darwin". Fine.
- "Syd" matches "Sydney". Who types "Syd" when talking to a bot?
- "New" matches "Newcastle"... or "Newman"? Now you need disambiguation logic.
- "Mel" matches "Melbourne". But does "Melton" also exist?

Claude is the caller of this tool. Claude will pass "Sydney", "Melbourne", "Brisbane" — it is an LLM, not a human fumbling with autocomplete. Case-insensitive exact match is sufficient:

```typescript
const key = location.toLowerCase();
const station = RADAR_STATIONS[key];
```

If you make the station mapping keys lowercase and do a simple lookup, that is one line. Partial matching is potentially many lines of fuzzy logic that adds bugs for no real benefit.

**Concrete change:** Replace "case-insensitive, partial match" with case-insensitive exact match. Add common aliases as separate keys in the mapping (e.g., `"terrey hills": "71"`, `"sydney": "71"`).

## 4. Temp file cleanup — REAL CONCERN, plan ignores it

**Verdict: Must address. The plan has a gap here.**

The plan says "saves to `/tmp/radar-IDR{code}-{timestamp}.gif`" and the test strategy says "clean up temp files after tests." But it never addresses runtime cleanup.

Consider: every time someone asks for a radar image, a ~30KB GIF is written to `/tmp`. In a family group chat, this might happen a few times a day. That is not going to fill a disk. But there is a subtler problem: the `send_image` tool in `signal.ts` reads the file, base64-encodes it, and sends it. After that, the file is useless. Nobody cleans it up.

Options (pick one):
1. **Do nothing and accept the leak.** At ~30KB per image, even 1000 images is 30MB. On a system with `/tmp` cleared on reboot, this is genuinely fine. But say so explicitly.
2. **Return the path and let Claude's next turn clean up.** Not reliable — Claude does not have a "delete file" tool.
3. **Clean up old radar files on each new request.** Before writing a new file, delete any `radar-IDR*.gif` files in tmpdir older than 1 hour. Simple, self-contained.

**Concrete change:** Option 3 is the cleanest. Add a small cleanup step at the start of the handler. Or at minimum, document option 1 as an explicit decision, not an oversight.

## 5. Test strategy — PROBLEMATIC for CI, fine for now

**Verdict: Hitting real BOM servers is fragile. But the existing tests already do it, so be consistent.**

The existing weather tests all hit `api.weather.bom.gov.au` directly. No mocking. This means:
- Tests fail when BOM is down or rate-limiting.
- Tests fail without network access.
- Tests are slow (each spawns a child process + makes HTTP calls).

The plan follows this same pattern for radar tests, which is consistent. But it is worth noting: the radar endpoint (`reg.bom.gov.au`) is a different domain from the API (`api.weather.bom.gov.au`). If one is up and the other is down, you get partial test failures.

For the radar test specifically, I would suggest one pragmatic addition: check that the response content-type is `image/gif` and that the file starts with `GIF89a` or `GIF87a` magic bytes. This validates the integration end-to-end. The plan mentions "check magic bytes" which is good.

**Concrete change:** No change to the overall strategy (stay consistent with existing tests), but do verify GIF magic bytes in the test, and consider marking radar tests with a `@network` tag or similar so they can be skipped in offline CI if that ever becomes an issue.

## 6. Range parameter — KEEP but simplify

**Verdict: Borderline YAGNI, but the implementation cost is near zero.**

The range parameter maps a string to a single digit suffix. That is a 4-line lookup table. The tool description can default to 128km and Claude will only use the parameter when explicitly asked. The cost of adding it is trivially low.

However, the plan dedicates an entire Task (Task 4) to this. That is over-planning for what amounts to:

```typescript
const RANGE_MAP: Record<string, string> = { '512km': '1', '256km': '2', '128km': '3', '64km': '4' };
const suffix = RANGE_MAP[range ?? '128km'] ?? '3';
```

**Concrete change:** Merge Task 4 into Task 3. Do not make range a separate task — it is 5 lines of code.

## 7. Risk to existing functionality — LOW, but verify

**Verdict: Minimal risk, one thing to watch.**

The changes are additive: new entries in the TOOLS array, new handler functions. The existing `bomFetch` helper uses the API domain (`api.weather.bom.gov.au`), while radar uses a different domain (`reg.bom.gov.au`). These do not interact.

The one risk: the plan adds `import` statements for `os` and `fs` (needed for tmpdir and file writing). If something goes wrong with those imports, the entire weather server fails to load — taking the existing 4 tools offline. This is extremely unlikely but worth noting.

**Concrete change:** None needed. But the implementation should keep the new imports at the top of the file where failures are obvious and immediate.

## 8. Error handling — MOSTLY FINE, one gap

**Verdict: Good enough, but handle the "BOM changes URL pattern" case.**

The plan handles:
- Unknown location: error with available stations (good, especially if `list_radar_stations` is removed per point 1).
- Missing parameters: handled by `requireString()` (existing pattern).
- Network errors: handled by `catchErrors()` wrapper (existing pattern).

But it does not explicitly address:
- **BOM returns 200 with non-GIF content** (e.g., an HTML error page). The plan should verify the response content-type or check GIF magic bytes before writing the file. Otherwise `send_image` will send a corrupt file.
- **BOM returns 404** for a supposedly valid station. This means the station mapping is stale. The error should say something like "Radar image not available for {station}. The station may be offline or the mapping may be outdated." Not just a generic HTTP error.

**Concrete change:** Add a content-type or magic byte check after fetching. If it is not a GIF, return an error rather than writing garbage to a file.

## 9. Two tools vs one — ONE IS ENOUGH

**Verdict: One tool. See point 1.**

This is a restatement of point 1. `list_radar_stations` and `get_radar_image` should be a single `get_radar_image` tool. When the location is invalid, the error response includes the station list. When it is valid, you get the image.

If there were a genuine use case for "show me all available radar stations without fetching an image," a separate tool would be justified. But in a family group chat, nobody asks "what radar stations exist?" — they ask "what does the radar look like in Sydney?"

## Summary of recommended changes

| # | Issue | Recommendation | Impact |
|---|-------|---------------|--------|
| 1 | `list_radar_stations` | Remove. Embed station list in `get_radar_image` error messages | Reduces scope |
| 2 | Hardcoded mapping | Keep, but add code comment explaining the choice | Documentation |
| 3 | Partial matching | Replace with case-insensitive exact match + aliases | Simplifies code |
| 4 | Temp file cleanup | Add cleanup of old radar files, or explicitly accept the leak | Closes a gap |
| 5 | Test strategy | Keep real-server tests, add GIF magic byte verification | Consistent |
| 6 | Range parameter | Keep, but merge into Task 3 (not a separate task) | Reduces task count |
| 7 | Existing functionality risk | Low. No changes needed | N/A |
| 8 | Error handling | Add content-type/magic byte validation on BOM response | Prevents corrupt files |
| 9 | Two tools vs one | One tool is sufficient | Reduces scope |

**Net effect:** The plan goes from 5 tasks and 2 new tools down to ~3 tasks and 1 new tool, with better error handling and simpler matching logic. The core approach (hardcoded stations, temp file, `reg.bom.gov.au`, pre-composited GIFs) is sound and should not change.
