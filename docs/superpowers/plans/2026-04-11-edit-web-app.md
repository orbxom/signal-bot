# Edit Web App & Web App Tooling Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `edit_web_app` (find-and-replace) and `create_web_app` (scaffold with collision detection) tools, upgrade the deploy dashboard, and update system prompt guidance.

**Architecture:** Two new tools added to the existing `webAppsServer` in `webApps.ts`, following the same handler pattern. The deploy dashboard template is upgraded inline. System prompt updated in `contextBuilder.ts`.

**Tech Stack:** TypeScript, Node.js fs APIs, vitest

---

## File Map

- **Modify:** `bot/src/mcp/servers/webApps.ts` — add `edit_web_app` and `create_web_app` tool definitions + handlers, upgrade dashboard HTML template in `deploy_web_apps`
- **Modify:** `bot/src/contextBuilder.ts:35` — update web apps system prompt line
- **Modify:** `bot/tests/mcp/webApps.test.ts` — add test suites for both new tools, update tool count assertion
- **Modify:** `bot/src/mcp/servers/webApps.ts` (CLAUDE.md tool list reference) — no change needed, CLAUDE.md lists tool counts per server which will need updating

---

### Task 1: `edit_web_app` — Tests

**Files:**
- Modify: `bot/tests/mcp/webApps.test.ts`

- [ ] **Step 1: Update tool count assertion**

In the `tool listing` describe block, update the expected count and add the new tool name:

```typescript
it('should have 9 tools', () => {
  expect(webAppsServer.tools).toHaveLength(9);
  const names = webAppsServer.tools.map(t => t.name);
  expect(names).toContain('write_web_app');
  expect(names).toContain('read_web_app');
  expect(names).toContain('edit_web_app');
  expect(names).toContain('create_web_app');
  expect(names).toContain('list_sites');
  expect(names).toContain('delete_site');
  expect(names).toContain('preview_web_app');
  expect(names).toContain('stop_preview');
  expect(names).toContain('deploy_web_apps');
});
```

- [ ] **Step 2: Add `edit_web_app` test suite**

Add this describe block after the `read_web_app` describe block:

```typescript
describe('edit_web_app', () => {
  it('should replace text in a file', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-test',
      content: '<h1>Hello World</h1>\n<p>Some content here</p>',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-test',
      old_text: 'Hello World',
      new_text: 'Updated Title',
    });
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain('Updated Title');

    const filePath = join(testDir, 'sites', 'edit-test', 'index.html');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('<h1>Updated Title</h1>\n<p>Some content here</p>');
  });

  it('should edit a specific filename', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-test',
      filename: 'styles.css',
      content: 'body { color: red; }',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-test',
      filename: 'styles.css',
      old_text: 'red',
      new_text: 'blue',
    });
    expect(result.isError).toBeFalsy();

    const filePath = join(testDir, 'sites', 'edit-test', 'styles.css');
    expect(readFileSync(filePath, 'utf-8')).toBe('body { color: blue; }');
  });

  it('should default filename to index.html', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-default',
      content: '<p>original</p>',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-default',
      old_text: 'original',
      new_text: 'modified',
    });
    expect(result.isError).toBeFalsy();

    const filePath = join(testDir, 'sites', 'edit-default', 'index.html');
    expect(readFileSync(filePath, 'utf-8')).toBe('<p>modified</p>');
  });

  it('should error when old_text is not found', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-notfound',
      content: '<h1>Hello</h1>',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-notfound',
      old_text: 'Goodbye',
      new_text: 'Hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not found');
  });

  it('should error when old_text matches multiple times', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-ambiguous',
      content: '<p>hello</p>\n<p>hello</p>\n<p>hello</p>',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-ambiguous',
      old_text: 'hello',
      new_text: 'bye',
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain('3 times');
  });

  it('should error when site does not exist', async () => {
    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'nonexistent',
      old_text: 'a',
      new_text: 'b',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not found');
  });

  it('should error when file does not exist', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'edit-nofile',
      content: '<h1>Hi</h1>',
    });

    const result = await webAppsServer.handlers.edit_web_app({
      site_name: 'edit-nofile',
      filename: 'missing.js',
      old_text: 'a',
      new_text: 'b',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not found');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: All new `edit_web_app` tests FAIL (handler doesn't exist yet). Existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add bot/tests/mcp/webApps.test.ts
git commit -m "test: add failing tests for edit_web_app tool"
```

---

### Task 2: `edit_web_app` — Implementation

**Files:**
- Modify: `bot/src/mcp/servers/webApps.ts`

- [ ] **Step 1: Add tool definition to TOOLS array**

Add this object to the `TOOLS` array, after the `read_web_app` entry:

```typescript
{
  name: 'edit_web_app',
  title: 'Edit Web App File',
  description:
    'Find and replace text in a web app file. The old_text must match exactly once in the file. Use this for surgical edits instead of rewriting entire files.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      site_name: {
        type: 'string',
        description: 'Site name to edit',
      },
      filename: {
        type: 'string',
        description: 'Filename to edit. Defaults to "index.html".',
      },
      old_text: {
        type: 'string',
        description: 'Exact text to find (must appear exactly once in the file)',
      },
      new_text: {
        type: 'string',
        description: 'Replacement text',
      },
    },
    required: ['site_name', 'old_text', 'new_text'],
  },
},
```

- [ ] **Step 2: Add handler**

Add this handler to the `handlers` object, after the `read_web_app` handler:

```typescript
edit_web_app(args) {
  return catchErrors(() => {
    const name = requireString(args, 'site_name');
    if (name.error) return name.error;
    const oldText = requireString(args, 'old_text');
    if (oldText.error) return oldText.error;
    const newText = requireString(args, 'new_text');
    if (newText.error) return newText.error;

    const nameError = validateSiteName(name.value);
    if (nameError) return error(nameError);

    const siteDir = getSiteDir(name.value);
    if (!existsSync(siteDir)) {
      return error(`Site "${name.value}" not found.`);
    }

    const filename = optionalString(args, 'filename', 'index.html');
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return error('Invalid filename. Path traversal not allowed.');
    }

    const filePath = path.join(siteDir, filename);
    if (!existsSync(filePath)) {
      return error(`File "${filename}" not found in site "${name.value}".`);
    }

    const content = readFileSync(filePath, 'utf-8');

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldText.value, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldText.value.length;
    }

    if (count === 0) {
      return error(`Text not found in ${filename}. Check for exact whitespace/indentation match.`);
    }
    if (count > 1) {
      return error(
        `Text found ${count} times in ${filename}. Provide more surrounding context to make the match unique.`,
      );
    }

    const updated = content.replace(oldText.value, newText.value);
    writeFileSync(filePath, updated, 'utf-8');

    // Build context snippet: show ~3 lines around the edit
    const editIdx = updated.indexOf(newText.value);
    const lines = updated.split('\n');
    let editLine = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
      charCount += lines[i].length + 1; // +1 for newline
      if (charCount > editIdx) {
        editLine = i;
        break;
      }
    }
    const snippetStart = Math.max(0, editLine - 1);
    const snippetEnd = Math.min(lines.length, editLine + 2);
    const snippet = lines.slice(snippetStart, snippetEnd).join('\n');

    return ok(
      `Edited ${filename} in site "${name.value}" (${updated.length} bytes).\n\nContext:\n${snippet}`,
    );
  }, 'Failed to edit web app');
},
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: All `edit_web_app` tests PASS. All existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add bot/src/mcp/servers/webApps.ts
git commit -m "feat: add edit_web_app tool for find-and-replace edits (#65)"
```

---

### Task 3: `create_web_app` — Tests

**Files:**
- Modify: `bot/tests/mcp/webApps.test.ts`

- [ ] **Step 1: Add `create_web_app` test suite**

Add this describe block after the `edit_web_app` describe block:

```typescript
describe('create_web_app', () => {
  it('should scaffold a site with three files', async () => {
    const result = await webAppsServer.handlers.create_web_app({
      site_name: 'new-site',
    });
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain('new-site');
    expect(text).toContain('index.html');
    expect(text).toContain('styles.css');
    expect(text).toContain('app.js');

    const siteDir = join(testDir, 'sites', 'new-site');
    expect(existsSync(join(siteDir, 'index.html'))).toBe(true);
    expect(existsSync(join(siteDir, 'styles.css'))).toBe(true);
    expect(existsSync(join(siteDir, 'app.js'))).toBe(true);
  });

  it('should use humanized site name as default title', async () => {
    await webAppsServer.handlers.create_web_app({
      site_name: 'birthday-card',
    });

    const html = readFileSync(join(testDir, 'sites', 'birthday-card', 'index.html'), 'utf-8');
    expect(html).toContain('<title>Birthday Card</title>');
    expect(html).toContain('Birthday Card');
  });

  it('should use custom title when provided', async () => {
    await webAppsServer.handlers.create_web_app({
      site_name: 'my-app',
      title: 'My Awesome App',
    });

    const html = readFileSync(join(testDir, 'sites', 'my-app', 'index.html'), 'utf-8');
    expect(html).toContain('<title>My Awesome App</title>');

    const css = readFileSync(join(testDir, 'sites', 'my-app', 'styles.css'), 'utf-8');
    expect(css).toContain('My Awesome App');

    const js = readFileSync(join(testDir, 'sites', 'my-app', 'app.js'), 'utf-8');
    expect(js).toContain('My Awesome App');
  });

  it('should error when site already exists', async () => {
    await webAppsServer.handlers.write_web_app({
      site_name: 'taken',
      content: '<h1>Existing</h1>',
    });

    const result = await webAppsServer.handlers.create_web_app({
      site_name: 'taken',
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain('already exists');
  });

  it('should error for invalid site name', async () => {
    const result = await webAppsServer.handlers.create_web_app({
      site_name: '../bad',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid site_name');
  });

  it('should link styles.css and app.js in index.html', async () => {
    await webAppsServer.handlers.create_web_app({
      site_name: 'linked-test',
    });

    const html = readFileSync(join(testDir, 'sites', 'linked-test', 'index.html'), 'utf-8');
    expect(html).toContain('styles.css');
    expect(html).toContain('app.js');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: All new `create_web_app` tests FAIL. All existing tests (including `edit_web_app`) PASS.

- [ ] **Step 3: Commit**

```bash
git add bot/tests/mcp/webApps.test.ts
git commit -m "test: add failing tests for create_web_app tool"
```

---

### Task 4: `create_web_app` — Implementation

**Files:**
- Modify: `bot/src/mcp/servers/webApps.ts`

- [ ] **Step 1: Add a `humanizeName` helper**

Add this function after the `getSiteDir` function (around line 61):

```typescript
function humanizeName(siteName: string): string {
  return siteName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
```

- [ ] **Step 2: Add tool definition to TOOLS array**

Add this object to the `TOOLS` array, before the `write_web_app` entry (so it appears first in tool listings):

```typescript
{
  name: 'create_web_app',
  title: 'Create Web App',
  description:
    'Create a new web app site with HTML/CSS/JS scaffold. Errors if the site name is already taken. Use this to start new sites, then edit_web_app or write_web_app to add content.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      site_name: {
        type: 'string',
        description: 'Site name (lowercase letters, numbers, hyphens). e.g. "timer", "todo-app"',
      },
      title: {
        type: 'string',
        description:
          'Page title. Defaults to humanized site name (e.g. "birthday-card" becomes "Birthday Card").',
      },
    },
    required: ['site_name'],
  },
},
```

- [ ] **Step 3: Add handler**

Add this handler to the `handlers` object, before the `write_web_app` handler:

```typescript
create_web_app(args) {
  return catchErrors(() => {
    const name = requireString(args, 'site_name');
    if (name.error) return name.error;

    const nameError = validateSiteName(name.value);
    if (nameError) return error(nameError);

    const siteDir = getSiteDir(name.value);
    if (existsSync(siteDir)) {
      return error(
        `Site "${name.value}" already exists. Choose a different name or use write_web_app to modify it.`,
      );
    }

    const title = optionalString(args, 'title', humanizeName(name.value));

    mkdirSync(siteDir, { recursive: true });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>${title}</h1>
  <script src="app.js"></script>
</body>
</html>`;

    writeFileSync(path.join(siteDir, 'index.html'), html, 'utf-8');
    writeFileSync(path.join(siteDir, 'styles.css'), `/* Styles for ${title} */\n`, 'utf-8');
    writeFileSync(path.join(siteDir, 'app.js'), `// App logic for ${title}\n`, 'utf-8');

    return ok(
      `Created site "${name.value}" with files:\n- index.html\n- styles.css\n- app.js`,
    );
  }, 'Failed to create web app');
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: All `create_web_app` tests PASS. All other tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/mcp/servers/webApps.ts
git commit -m "feat: add create_web_app tool with scaffold and collision detection"
```

---

### Task 5: Dashboard Enhancement

**Files:**
- Modify: `bot/src/mcp/servers/webApps.ts`
- Modify: `bot/tests/mcp/webApps.test.ts`

- [ ] **Step 1: Add dashboard test**

Add this test to the `deploy_web_apps` describe block, after the existing "should error when no sites exist" test:

```typescript
it('should generate a dashboard index.html with site cards', async () => {
  await webAppsServer.handlers.write_web_app({ site_name: 'alpha', content: '<h1>A</h1>' });
  await webAppsServer.handlers.write_web_app({
    site_name: 'beta',
    filename: 'index.html',
    content: '<h1>B</h1>',
  });
  await webAppsServer.handlers.write_web_app({
    site_name: 'beta',
    filename: 'styles.css',
    content: 'body {}',
  });

  // Deploy will fail (no real SWA CLI), but the index.html is generated before the CLI call
  process.env.SWA_DEPLOYMENT_TOKEN = 'fake-token';
  await webAppsServer.handlers.deploy_web_apps({}).catch(() => {});

  const indexPath = join(testDir, 'sites', 'index.html');
  expect(existsSync(indexPath)).toBe(true);

  const html = readFileSync(indexPath, 'utf-8');
  expect(html).toContain('Signal Bot Sites');
  expect(html).toContain('alpha');
  expect(html).toContain('beta');
  // Should have card-like structure with file info
  expect(html).toContain('index.html');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: The new dashboard test MAY pass already since an index.html is generated, but it should fail on the card structure assertions. Check the output.

- [ ] **Step 3: Upgrade the dashboard template**

In the `deploy_web_apps` handler, replace the `siteLinks` and `rootIndex` generation (the block that starts with `const siteLinks = entries.map(...)` and ends with the closing `</html>` template) with:

```typescript
const siteCards = entries
  .map(e => {
    const sd = path.join(sitesDir, e.name);
    const files = readdirSync(sd);
    const totalSize = files.reduce((sum, f) => {
      const stat = statSync(path.join(sd, f));
      return sum + stat.size;
    }, 0);
    const sizeKb = (totalSize / 1024).toFixed(1);
    return `      <a href="/${e.name}/" class="card">
        <h2>${e.name}</h2>
        <p class="files">${files.join(', ')}</p>
        <p class="size">${sizeKb} KB</p>
      </a>`;
  })
  .join('\n');

const rootIndex = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Bot Sites</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;padding:2rem}
h1{text-align:center;color:#7c3aed;margin-bottom:2rem;font-size:1.8rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.5rem;max-width:960px;margin:0 auto}
.card{display:block;background:#16213e;border-radius:12px;padding:1.5rem;text-decoration:none;color:#e0e0e0;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(124,58,237,.3)}
.card h2{color:#60a5fa;font-size:1.2rem;margin-bottom:.5rem}
.card .files{font-size:.85rem;color:#94a3b8;margin-bottom:.25rem}
.card .size{font-size:.8rem;color:#64748b}
</style>
</head><body>
<h1>Signal Bot Sites</h1>
<div class="grid">
${siteCards}
</div>
</body></html>`;
```

Note: the `readdirSync` and `statSync` imports are already at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: All tests PASS including the new dashboard test.

- [ ] **Step 5: Commit**

```bash
git add bot/src/mcp/servers/webApps.ts bot/tests/mcp/webApps.test.ts
git commit -m "feat: upgrade deploy dashboard to card grid layout"
```

---

### Task 6: System Prompt Update

**Files:**
- Modify: `bot/src/contextBuilder.ts:35`

- [ ] **Step 1: Update the web apps system prompt line**

Replace the existing web apps line (line 35 in `contextBuilder.ts`):

```
- Web apps (write_web_app, read_web_app, list_sites, delete_site, preview_web_app, deploy_web_apps) — build single-file HTML/JS/CSS websites, preview locally, and deploy to Azure Static Web Apps. Use preview_web_app + Playwright to visually test before deploying. After deploy, share the live URL with the group.
```

With:

```
- Web apps (create_web_app, write_web_app, edit_web_app, read_web_app, list_sites, delete_site, preview_web_app, deploy_web_apps) — build multi-file HTML/CSS/JS websites. Use create_web_app to start new sites (scaffolds index.html, styles.css, app.js). Use edit_web_app for surgical changes to existing files (find-and-replace). Use write_web_app to create or overwrite whole files. Use preview_web_app + Playwright to visually test before deploying. After deploy, share the live URL with the group.
```

- [ ] **Step 2: Run lint and tests**

Run: `cd bot && npm run check && npx vitest run`
Expected: Lint passes. All tests pass.

- [ ] **Step 3: Commit**

```bash
git add bot/src/contextBuilder.ts
git commit -m "docs: update system prompt for new web app tools"
```

---

### Task 7: CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add webApps server to MCP Servers list**

The webApps server is missing from CLAUDE.md's MCP Servers section. Add it after the `personas.ts` line (line 58):

```
- `webApps.ts` — create/write/edit/read web app sites, preview locally, deploy to Azure Static Web Apps (9 tools)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add webApps server to CLAUDE.md MCP server list"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run the full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass, zero failures.

- [ ] **Step 2: Run lint and format check**

Run: `cd bot && npm run check`
Expected: No lint or format errors.

- [ ] **Step 3: Verify tool count manually**

Run: `cd bot && npx vitest run tests/mcp/webApps.test.ts`
Expected: "9 tools" assertion passes, confirming both new tools are registered.
