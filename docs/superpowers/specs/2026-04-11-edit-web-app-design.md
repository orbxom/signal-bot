# Edit Web App & Web App Tooling Improvements

**Date:** 2026-04-11
**Issue:** #65 — Add edit_web_app tool for surgical find-and-replace edits
**Approach:** Incremental tool addition to existing `webApps.ts` server

## Context

The web app feature (create websites via Signal chat) has become one of the most popular bot capabilities. The current toolset (`write_web_app`, `read_web_app`, `list_sites`, `delete_site`, `preview_web_app`, `deploy_web_apps`) works but has pain points:

- Editing large files requires regenerating the entire file via `write_web_app`, which hits Claude's output token limit on files over ~600 lines.
- No scaffolding — every new site starts from scratch, and Claude must generate all boilerplate.
- No name collision detection — creating a site with an existing name silently overwrites it.
- The auto-generated dashboard is a bare list of links.

This is the first of several planned expansions to the web app feature.

## Changes

### 1. `edit_web_app` Tool

Find-and-replace on a single file within a site, modeled on the Claude Code Edit tool.

**Parameters:**
- `site_name` (string, required) — target site
- `filename` (string, optional, default `index.html`) — file to edit
- `old_text` (string, required) — exact text to find
- `new_text` (string, required) — replacement text

**Behavior:**
1. Validate site name and filename (same checks as existing tools).
2. Read the file. Verify `old_text` appears exactly once. Error if not found or ambiguous.
3. Replace the matched text with `new_text`.
4. Write the file back.
5. Return confirmation with a ~3-line context snippet around the edit location, plus the new file size.

**Error messages:**
- Not found: `"Text not found in {filename}. Check for exact whitespace/indentation match."`
- Ambiguous: `"Text found {n} times in {filename}. Provide more surrounding context to make the match unique."`

### 2. `create_web_app` Tool

Scaffolds a new site with the standard HTML/CSS/JS three-file structure.

**Parameters:**
- `site_name` (string, required) — site name
- `title` (string, optional, default: humanized site name, e.g. `birthday-card` → `Birthday Card`) — page title

**Behavior:**
1. Validate site name.
2. Check if site directory already exists — hard error: `"Site '{name}' already exists. Choose a different name or use write_web_app to modify it."`
3. Create directory with three files:
   - `index.html` — minimal HTML5 skeleton with viewport meta, links `styles.css` and `app.js`, uses the title
   - `styles.css` — empty with comment header `/* Styles for {title} */`
   - `app.js` — empty with comment header `// App logic for {title}`
4. Return confirmation listing the created files.

The scaffold is intentionally bare — just the wiring between files. Claude fills in content via `write_web_app` or `edit_web_app`.

### 3. No Changes to `write_web_app`

`write_web_app` stays unchanged. It is intentionally idempotent — used for both creating and updating files. Adding collision detection would break the update workflow. The collision guard lives in `create_web_app`, which is the explicit "start a new project" action. System prompt guidance steers Claude toward `create_web_app` for new sites.

### 4. Dashboard Enhancement

Upgrade the auto-generated root `index.html` (created during `deploy_web_apps`) from a bare link list to a proper dashboard.

**Dashboard content:**
- Title: "Signal Bot Sites"
- Card grid layout — one card per site showing:
  - Site name (linked to the site)
  - File list (e.g. "index.html, styles.css, app.js")
  - Total size
- Responsive, dark theme (consistent with existing styling direction)
- Pure static HTML/CSS, no JS dependencies

**What stays the same:**
- Generated inline in the `deploy_web_apps` handler
- Overwrites `sitesDir/index.html` on each deploy
- No separate tool or build step

### 5. System Prompt Update

Update the web apps guidance in `contextBuilder.ts`:

> Web apps (create_web_app, write_web_app, edit_web_app, read_web_app, list_sites, delete_site, preview_web_app, deploy_web_apps) — build multi-file HTML/CSS/JS websites. Use create_web_app to start new sites (scaffolds index.html, styles.css, app.js). Use edit_web_app for surgical changes to existing files (find-and-replace). Use write_web_app to create or overwrite whole files. Use preview_web_app + Playwright to visually test before deploying. After deploy, share the live URL with the group.

Key shifts from current guidance:
- Leads with `create_web_app` as the starting point
- Positions `edit_web_app` as the default for changes
- Mentions multi-file structure instead of "single-file"

### 6. Testing

All tests in `bot/tests/mcp/webApps.test.ts`, following existing patterns (isolated temp dirs, direct handler calls).

**`edit_web_app` tests:**
- Successful find-and-replace
- `old_text` not found → error
- `old_text` found multiple times → error with count
- Site doesn't exist → error
- File doesn't exist → error
- Filename defaults to `index.html`

**`create_web_app` tests:**
- Creates three files (index.html, styles.css, app.js)
- Title defaults to humanized site name
- Custom title is used
- Site already exists → hard error
- Invalid site name → error

**Dashboard tests:**
- Deploy generates root `index.html` with card layout containing links to all sites

## Files Changed

- `bot/src/mcp/servers/webApps.ts` — add `edit_web_app` tool, `create_web_app` tool, upgrade dashboard template
- `bot/src/contextBuilder.ts` — update web apps system prompt guidance
- `bot/tests/mcp/webApps.test.ts` — add tests for new tools and dashboard

## Out of Scope

- Template variants (e.g. "game", "dashboard" scaffolds) — future expansion
- Library management tools — Claude already knows CDN patterns
- TypeScript support / build step — JS only for now
- Auto-suffixing on name collision — hard error, Claude picks a new name
